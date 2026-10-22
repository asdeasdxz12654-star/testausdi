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
const importer = require('./importer');
const ai = require('./ai');
const mapping = require('./mapping');
const settings = require('./settings');
const pkg = require('../package.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
}

function readBody(req, limitMb = 2) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) { reject(new HttpError(413, `요청이 너무 큽니다 (최대 ${limitMb}MB)`)); req.destroy(); return; }
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
route('PUT', '/api/config', (_, body) => settings.save(body));
route('GET', '/api/settings/devices', () => ({ devices: settings.deviceList(), models: settings.MODELS, efforts: settings.EFFORTS }));
route('POST', '/api/settings/inspect', (_, body) => settings.inspectSite(body.url));

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

// ---- 엑셀 가져오기 ----
// Google 스프레드시트는 열 배치를 바꿀 때마다 다시 받지 않도록 10분간 보관한다
const sheetCache = new Map();
async function googleSheet(url, refresh) {
  const hit = sheetCache.get(url);
  if (hit && !refresh && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const got = await importer.fetchGoogleSheet(url);
  const entry = { ...got, at: Date.now() };
  sheetCache.set(url, entry);
  return entry;
}

route('POST', '/api/import/preview', async (_, body) => {
  let buffer;
  let fileName = body.fileName;
  let sourceUrl = null;
  if (body.url) {
    const g = await googleSheet(body.url, body.refresh);
    buffer = g.buffer;
    fileName = g.fileName;
    sourceUrl = String(body.url).trim();
  } else {
    if (!body.data) throw new HttpError(400, '파일이 없습니다');
    if (!/\.(xlsx|csv|tsv|txt)$/i.test(fileName || '')) throw new HttpError(400, '.xlsx, .csv, .tsv 파일만 가져올 수 있습니다. .xls는 엑셀에서 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 바꿔 주세요');
    buffer = Buffer.from(body.data, 'base64');
  }
  const config = store.getConfig();
  return importer.parseWorkbook(buffer, {
    fileName, sourceUrl, sheet: body.sheet, mapping: body.mapping,
    elements: store.getElements(), existingIds: store.listTcs().map((t) => t.id),
    defaultPlatforms: (config.import && config.import.defaultPlatforms) || ['pc', 'mw'],
  });
});

route('POST', '/api/import/commit', (_, body) => {
  if (!Array.isArray(body.tcs) || !body.tcs.length) throw new HttpError(400, '가져올 TC를 하나 이상 고르세요');
  const c = ctx();
  const existing = new Set(store.listTcs().map((t) => t.id));
  const result = { added: [], updated: [], skipped: [], failed: [] };
  for (const raw of body.tcs) {
    try {
      const tc = validateTc(raw, c);
      if (existing.has(tc.id) && !body.overwrite) { result.skipped.push({ id: tc.id, reason: '같은 ID가 이미 있습니다' }); continue; }
      store.saveTc(tc);
      (existing.has(tc.id) ? result.updated : result.added).push(tc.id);
      existing.add(tc.id);
    } catch (e) {
      result.failed.push({ id: raw && raw.id, reason: e.message });
    }
  }
  return result;
});

route('GET', '/api/import/template', async () => ({
  download: { buffer: Buffer.from(await importer.templateWorkbook()), name: 'AutoTC_TC양식.xlsx', asciiName: 'AutoTC_TC_template.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
}));

// ---- TC 영역 매핑 ----
route('GET', '/api/ai/settings', () => ai.publicSettings());
route('PUT', '/api/ai/settings', (_, body) => ai.saveSettings(body));
route('POST', '/api/ai/check', () => {
  const config = store.getConfig();
  return ai.checkKey(ai.makeClient(ai.getSettings().apiKey), (config.ai && config.ai.model) || 'claude-opus-5-5');
});
route('GET', '/api/mapping', () => mapping.listProjects());
route('POST', '/api/mapping', (_, body) => mapping.createProject(body.name));
route('GET', '/api/mapping/:id', ({ id }) => mapping.view(id));
route('PUT', '/api/mapping/:id', ({ id }, body) => { mapping.updateProject(id, body); return mapping.view(id); });
route('DELETE', '/api/mapping/:id', ({ id }) => { mapping.deleteProject(id); return { ok: true }; });
route('POST', '/api/mapping/:id/files', ({ id }, body) => { mapping.addFile(id, body); return mapping.view(id); });
route('DELETE', '/api/mapping/:id/files/:fileId', ({ id, fileId }) => { mapping.removeFile(id, fileId); return mapping.view(id); });
route('POST', '/api/mapping/:id/figma', async ({ id }, body) => {
  const r = await mapping.addFigma(id, body.url);
  return { ...mapping.view(id), added: r.added, skipped: r.skipped };
});
route('POST', '/api/mapping/:id/analyze', ({ id }, body) => { mapping.startAnalysis(id, body); return mapping.view(id); });
route('POST', '/api/mapping/:id/analyze-rules', ({ id }, body) => mapping.analyzeRules(id, body));
route('POST', '/api/mapping/:id/claude-code/export', ({ id }, body) => mapping.exportForClaudeCode(id, body));
route('POST', '/api/mapping/:id/claude-code/import', ({ id }) => mapping.importClaudeCode(id));
route('PUT', '/api/mapping/:id/results/:tcId', ({ id, tcId }, body) => mapping.review(id, tcId, body));
route('POST', '/api/mapping/:id/apply', ({ id }) => mapping.apply(id));

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
      // 엑셀 업로드는 base64로 오므로 한도를 늘린다
      // 엑셀·기획서·디자인 업로드는 base64로 오므로 한도를 늘린다
      const big = pathname.startsWith('/api/import/') || /^\/api\/mapping\/[^/]+\/files$/.test(pathname);
      const body = req.method === 'GET' ? {} : await readBody(req, big ? 45 : 2);
      const data = await r.handler(params, body, url);
      if (data && data.download) {
        res.writeHead(200, {
          'Content-Type': data.download.type,
          'Content-Disposition': `attachment; filename="${data.download.asciiName}"; filename*=UTF-8''${encodeURIComponent(data.download.name)}`,
          'Content-Length': data.download.buffer.length,
        });
        return res.end(data.download.buffer);
      }
      return sendJson(res, 200, data);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: '허용되지 않는 요청입니다' });
  if (pathname.startsWith('/files/')) return sendFile(res, P.RUNS, pathname.slice('/files/'.length));
  if (pathname.startsWith('/mapping-files/')) return sendFile(res, path.join(P.STATE, 'mapping'), pathname.slice('/mapping-files/'.length));
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
