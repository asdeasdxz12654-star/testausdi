// 로컬 콘솔 서버. 127.0.0.1에서만 열리며 화면(web/)과 API, 실행 결과 파일을 제공한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const { ACTIONS, PLATFORMS, PLATFORM_LABELS } = require('./actions');
const { PRIORITIES, AUTOMATION, validateTc } = require('./tc');
const { generate } = require('./generator');
const { precheck } = require('./precheck');
const { CLASSIFICATIONS, ISSUE_TYPE } = require('./classify');
const issuesLib = require('./issues');
const runner = require('./runner');
const pkg = require('../package.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new HttpError(413, '요청이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendFile(res, base, rel) {
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return sendJson(res, 403, { error: '접근할 수 없는 경로입니다' });
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: '파일이 없습니다' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(abs).pipe(res);
  });
}

const ctx = () => ({ config: store.getConfig(), elements: store.getElements(), flows: store.getFlows(), testData: store.getTestData() });

// ---- API ----
route('GET', '/api/ping', () => ({ app: 'autotc', version: pkg.version }));

route('GET', '/api/meta', () => ({
  version: pkg.version, actions: ACTIONS, platforms: PLATFORMS, platformLabels: PLATFORM_LABELS,
  priorities: PRIORITIES, automation: AUTOMATION, classifications: CLASSIFICATIONS, issueTypeOf: ISSUE_TYPE,
  statuses: { BUG: issuesLib.BUG_STATUSES, OTHER: issuesLib.OTHER_STATUSES }, severities: issuesLib.SEVERITIES,
}));

route('GET', '/api/config', () => store.getConfig());

route('GET', '/api/tcs', () => store.listTcs());
route('GET', '/api/tcs/:id', ({ id }) => store.getTc(id));
route('POST', '/api/tcs', (_, body) => {
  const c = ctx();
  const tc = validateTc(body, c);
  if (store.listTcs().some((t) => t.id === tc.id)) throw new HttpError(409, `이미 있는 TC ID입니다: ${tc.id}`);
  store.saveTc(tc);
  return tc;
});
route('PUT', '/api/tcs/:id', ({ id }, body) => {
  store.getTc(id);
  const tc = validateTc(body, ctx());
  if (tc.id !== id) {
    if (store.listTcs().some((t) => t.id === tc.id)) throw new HttpError(409, `이미 있는 TC ID입니다: ${tc.id}`);
    store.deleteTc(id);
  }
  store.saveTc(tc);
  return tc;
});
route('DELETE', '/api/tcs/:id', ({ id }) => { store.deleteTc(id); return { ok: true }; });

// 저장 전 TC로 엔진별 코드 미리보기
route('POST', '/api/preview', (_, body) => {
  const c = ctx();
  const tc = validateTc(body, c);
  const out = {};
  for (const p of PLATFORMS) {
    try { out[p] = generate(tc, p, c); } catch (e) { out[p] = { error: e.message }; }
  }
  return out;
});

route('GET', '/api/elements', () => store.getElements());
route('PUT', '/api/elements', (_, body) => {
  const errors = [];
  if (!body || typeof body.screens !== 'object' || typeof body.elements !== 'object') throw new HttpError(400, 'screens와 elements가 필요합니다');
  const NAME = /^[a-zA-Z][\w]*(\.[\w]+)+$/;
  for (const [k, s] of Object.entries(body.screens)) {
    if (!NAME.test(k)) errors.push(`화면 이름 형식 오류: ${k} (예: screen.login)`);
    if (!s.label) errors.push(`${k}: 이름(label)을 입력하세요`);
  }
  for (const [k, e] of Object.entries(body.elements)) {
    if (!NAME.test(k)) errors.push(`요소 이름 형식 오류: ${k} (예: login.submit)`);
    if (!e.label) errors.push(`${k}: 이름(label)을 입력하세요`);
    if (e.web && !['testId', 'css', 'role', 'text'].some((t) => e.web[t])) errors.push(`${k}: 웹 식별자 값이 비어 있습니다`);
  }
  // 사용 중인 요소가 지워지지 않았는지 확인
  for (const tc of store.listTcs()) {
    tc.steps.forEach((s, i) => {
      const def = ACTIONS[s.action];
      if (def.target === 'element' && !body.elements[s.target]) errors.push(`${tc.id} ${i + 1}번 스텝이 쓰는 요소 ${s.target}이(가) 없습니다`);
      if (def.target === 'screen' && !body.screens[s.target]) errors.push(`${tc.id} ${i + 1}번 스텝이 쓰는 화면 ${s.target}이(가) 없습니다`);
    });
  }
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  store.saveElements(body);
  return body;
});

route('GET', '/api/flows', () => store.getFlows());

route('GET', '/api/devices', () => precheck(store.getConfig()));

route('GET', '/api/runs', () => {
  const runs = store.listRuns();
  const cur = runner.getCurrent();
  return runs.map((r) => (cur && r.id === cur.id ? { ...r, status: cur.status, phase: cur.phase } : r));
});
route('POST', '/api/runs', (_, body) => runner.startRun(body));
route('GET', '/api/runs/:id', ({ id }) => {
  const cur = runner.getCurrent();
  if (cur && cur.id === id) return cur;
  return runner.withSummary(store.getRun(id));
});
route('PUT', '/api/runs/:id/results/:key', ({ id, key }, body) => {
  const cur = runner.getCurrent();
  if (cur && cur.id === id) throw new HttpError(409, '실행이 끝난 뒤 분류를 확정할 수 있습니다');
  const run = store.getRun(id);
  const r = run.results.find((x) => x.key === key);
  if (!r) throw new HttpError(404, `결과를 찾을 수 없습니다: ${key}`);
  if (!CLASSIFICATIONS[body.classification]) throw new HttpError(400, `알 수 없는 분류: ${body.classification}`);
  r.classification.confirmed = body.classification;
  store.saveRun(run);
  if (r.issueId) {
    const issues = store.getIssues();
    const issue = issues.find((i) => i.id === r.issueId);
    if (issue) {
      issue.classification = body.classification;
      issuesLib.updateIssue(issue, { type: ISSUE_TYPE[body.classification] });
      issue.history.push({ at: new Date().toISOString(), runId: id, event: `QA 분류 확정: ${CLASSIFICATIONS[body.classification]}` });
      store.saveIssues(issues);
    }
  }
  return runner.withSummary(run);
});

route('GET', '/api/issues', () => store.getIssues());
route('PUT', '/api/issues/:id', ({ id }, body) => {
  const issues = store.getIssues();
  const issue = issues.find((i) => i.id === id);
  if (!issue) throw new HttpError(404, `이슈를 찾을 수 없습니다: ${id}`);
  try { issuesLib.updateIssue(issue, body); } catch (e) { throw new HttpError(400, e.message); }
  store.saveIssues(issues);
  return issue;
});

// ---- 서버 ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) return sendJson(res, 404, { error: `없는 API입니다: ${req.method} ${pathname}` });
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const data = await r.handler(params, body, url);
      return sendJson(res, 200, data);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: '허용되지 않는 요청입니다' });
  if (pathname.startsWith('/files/')) return sendFile(res, P.RUNS, pathname.slice('/files/'.length));
  return sendFile(res, P.WEB, pathname === '/' ? 'index.html' : pathname.slice(1));
}

function start(port = Number(process.env.AUTOTC_PORT) || 4870) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ url }) => console.log(`AutoTC 콘솔: ${url}`));
}
