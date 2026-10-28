// 거래처 지도 — 이관 내역·좌표를 GitHub 저장소의 JSON 파일에 저장하는 Vercel 서버 함수
// 필요한 Vercel 환경변수:
//   GITHUB_TOKEN   : 이 저장소 하나만 Contents 읽기/쓰기 권한이 있는 fine-grained 토큰
//   GITHUB_REPO    : "아이디/저장소이름"  (예: jinhyuck/seoul3-map)
//   GITHUB_BRANCH  : 브랜치 이름 (생략하면 main)
//   TEAM_PASSWORD  : 이관 저장용 팀 비밀번호

const crypto = require('crypto');

const FILES = { xfer: 'data/xfer.json', geo: 'data/geo.json' };
const GEO_HOW = new Set(['addr', 'place', 'kwaddr', 'file']);

const env = () => ({
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  branch: process.env.GITHUB_BRANCH || 'main',
  pw: process.env.TEAM_PASSWORD || ''
});

function gh(E, path, { method = 'GET', body, raw = false } = {}) {
  const url = `https://api.github.com/repos/${E.repo}/contents/${path}` + (method === 'GET' ? `?ref=${encodeURIComponent(E.branch)}` : '');
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${E.token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'acct-map',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function readFile(E, path) {
  const r = await gh(E, path);
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw httpErr(502, `GitHub 읽기 실패 (${r.status})`);
  const j = await r.json();
  let text;
  if (j.content && j.encoding === 'base64') text = Buffer.from(j.content, 'base64').toString('utf8');
  else {                                     // 1MB 넘는 파일은 raw로 다시 읽기
    const r2 = await gh(E, path, { raw: true });
    if (!r2.ok) throw httpErr(502, `GitHub 읽기 실패 (${r2.status})`);
    text = await r2.text();
  }
  let data = null;
  try { data = text.trim() ? JSON.parse(text) : null; } catch (e) { throw httpErr(500, `${path} 파일 형식이 올바르지 않습니다`); }
  return { data, sha: j.sha };
}

async function writeFile(E, path, data, sha, message) {
  const body = {
    message, branch: E.branch,
    content: Buffer.from(JSON.stringify(data, null, 1), 'utf8').toString('base64'),
    ...(sha ? { sha } : {})
  };
  const r = await gh(E, path, { method: 'PUT', body });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw httpErr(502, `GitHub 저장 실패 (${r.status})`);
  return { conflict: false };
}

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const empty = file => file === 'xfer' ? { items: {}, reps: {}, log: [] } : {};
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function applyXfer(data, ops, reps) {
  data.items = data.items || {}; data.reps = data.reps || {}; data.log = data.log || [];
  const now = new Date().toISOString(), by = '';
  let n = 0;
  for (const [id, v] of Object.entries(reps)) {           // 인원 추가 (이관보다 먼저)
    if (v === null) continue;
    data.reps[id] = { ...v, at: now.slice(0, 10) }; data.log.push({ rep: id, name: v.name, ts: now }); n++;
  }
  for (const [k, v] of Object.entries(ops)) {
    if (v === null) {
      if (data.items[k]) { delete data.items[k]; data.log.push({ k, to: null, ts: now }); n++; }
      continue;
    }
    const cur = data.items[k];
    if (cur && cur.to === v.to) continue;
    data.items[k] = { to: v.to, at: v.at };
    data.log.push({ k, to: v.to, ts: now }); n++;
  }
  for (const [id, v] of Object.entries(reps)) {           // 인원 삭제 (이관 처리 뒤)
    if (v !== null || !data.reps[id]) continue;
    if (Object.values(data.items).some(x => x.to === id)) throw httpErr(409, '이 인원에게 이관된 거래처가 있어 삭제할 수 없습니다. 먼저 되돌려 주세요');
    delete data.reps[id]; data.log.push({ rep: id, del: true, ts: now }); n++;
  }
  if (data.log.length > 2000) data.log = data.log.slice(-2000);
  return n;
}
function applyGeo(data, ops) {
  let n = 0;
  for (const [k, v] of Object.entries(ops)) if (!data[k]) { data[k] = v; n++; }
  return n;
}

function validateReps(reps) {
  if (reps == null) return {};
  if (typeof reps !== 'object' || Array.isArray(reps) || Object.keys(reps).length > 50) throw httpErr(400, '잘못된 인원 정보입니다');
  const out = {};
  for (const [id, v] of Object.entries(reps)) {
    if (!/^[A-Za-z0-9]{3,24}$/.test(id)) throw httpErr(400, '잘못된 사번입니다');
    if (v === null) { out[id] = null; continue; }
    const name = clean(v && v.name, 20), office = clean(v && v.office, 30), div = clean(v && v.div, 30);
    if (!name || !office) throw httpErr(400, '이름과 사무소를 넣어 주세요');
    out[id] = { name, office, div };
  }
  return out;
}
function validate(file, ops) {
  if (ops == null && file === 'xfer') ops = {};
  if (!ops || typeof ops !== 'object' || Array.isArray(ops)) throw httpErr(400, '잘못된 요청입니다');
  const keys = Object.keys(ops);
  if (keys.length > (file === 'geo' ? 5000 : 3000)) throw httpErr(400, '한 번에 저장할 수 있는 건수를 넘었습니다');
  const out = {};
  for (const k of keys) {
    if (k.length > 300) throw httpErr(400, '잘못된 키입니다');
    const v = ops[k];
    if (file === 'xfer') {
      if (k.length > 40) throw httpErr(400, '잘못된 거래처 키입니다');
      if (v === null) { out[k] = null; continue; }
      if (!v || !/^[A-Za-z0-9]{3,24}$/.test(String(v.to)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.at))) throw httpErr(400, '잘못된 이관 정보입니다');
      out[k] = { to: String(v.to), at: String(v.at) };
    } else {
      if (!Array.isArray(v) || v.length !== 3) throw httpErr(400, '잘못된 좌표입니다');
      const [lat, lng, how] = v;
      if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132) || !GEO_HOW.has(how)) throw httpErr(400, '잘못된 좌표입니다');
      out[k] = [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, how];
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (s, o) => res.status(s).json(o);
  try {
    const E = env();
    if (!E.token || !E.repo) throw httpErr(500, 'Vercel 환경변수(GITHUB_TOKEN, GITHUB_REPO)가 설정되지 않았습니다');
    const file = String((req.query && req.query.file) || (req.body && req.body.file) || '');
    if (!FILES[file]) throw httpErr(400, 'file은 xfer 또는 geo여야 합니다');
    const path = FILES[file];

    if (req.method === 'GET') {
      const { data } = await readFile(E, path);
      return send(200, { ok: true, data: data || empty(file) });
    }
    if (req.method !== 'POST') return send(405, { error: 'GET 또는 POST만 됩니다' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    if (file === 'xfer') {
      if (!E.pw) throw httpErr(500, 'Vercel 환경변수 TEAM_PASSWORD가 설정되지 않았습니다');
      if (!sameText(body.password || '', E.pw)) throw httpErr(401, '팀 비밀번호가 맞지 않습니다');
    }
    const ops = validate(file, body.ops);
    const reps = file === 'xfer' ? validateReps(body.reps) : {};

    for (let i = 0; i < 4; i++) {           // 다른 사람이 동시에 저장했으면 최신본에 다시 반영
      const { data, sha } = await readFile(E, path);
      const cur = data || empty(file);
      const n = file === 'xfer' ? applyXfer(cur, ops, reps) : applyGeo(cur, ops);
      if (!n) return send(200, { ok: true, changed: 0, data: cur });
      const msg = file === 'xfer' ? (Object.keys(reps).length ? `인원 변경 ${Object.keys(reps).length}건` + (Object.keys(ops).length ? ` · 이관 ${Object.keys(ops).length}건` : '') : `이관 ${n}건`) : `좌표 ${n}건 추가`;
      const w = await writeFile(E, path, cur, sha, msg);
      if (!w.conflict) return send(200, { ok: true, changed: n, data: cur });
      await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    }
    throw httpErr(409, '다른 사람이 동시에 저장하고 있습니다. 잠시 후 다시 시도해 주세요');
  } catch (e) {
    return send(e.status || 500, { error: e.message || '서버 오류' });
  }
};
