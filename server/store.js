// JSON 파일 저장소. TC·요소 맵·설정은 data/ 아래(Git 관리), 실행 결과·이슈는 data/state/ 아래(Git 제외)에 둔다.
const fs = require('fs');
const path = require('path');
const P = require('./paths');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (e instanceof SyntaxError) throw new Error(`${path.relative(P.ROOT, file)} 파일의 JSON 형식이 올바르지 않습니다: ${e.message}`);
    throw e;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

function assertId(id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpError(400, `${what}는 영문, 숫자, -, _ 만 쓸 수 있습니다: ${id}`);
  }
}

function tcFile(id) {
  assertId(id, 'TC ID');
  return path.join(P.TCS, `${id}.json`);
}

function listTcs() {
  if (!fs.existsSync(P.TCS)) return [];
  return fs.readdirSync(P.TCS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(P.TCS, f)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getTc(id) {
  const file = tcFile(id);
  if (!fs.existsSync(file)) throw new HttpError(404, `TC를 찾을 수 없습니다: ${id}`);
  return readJson(file);
}

function saveTc(tc) {
  writeJson(tcFile(tc.id), tc);
}

function deleteTc(id) {
  const file = tcFile(id);
  if (!fs.existsSync(file)) throw new HttpError(404, `TC를 찾을 수 없습니다: ${id}`);
  fs.unlinkSync(file);
}

const getConfig = () => readJson(path.join(P.DATA, 'config.json'));
const getElements = () => readJson(path.join(P.DATA, 'elements.json'), { screens: {}, elements: {} });
const saveElements = (data) => writeJson(path.join(P.DATA, 'elements.json'), data);
const getFlows = () => readJson(path.join(P.DATA, 'flows.json'), {});
const getTestData = () => readJson(path.join(P.DATA, 'testdata.json'), {});

// API 응답 명세(JSON Schema). data/schemas/<이름>.json
function getSchemas() {
  const dir = path.join(P.DATA, 'schemas');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [path.basename(f, '.json'), readJson(path.join(dir, f))]));
}

const getIssues = () => readJson(path.join(P.STATE, 'issues.json'), []);
const saveIssues = (issues) => writeJson(path.join(P.STATE, 'issues.json'), issues);
const getHistory = () => readJson(path.join(P.STATE, 'history.json'), {});
const saveHistory = (history) => writeJson(path.join(P.STATE, 'history.json'), history);

function runFile(id) {
  assertId(id, '실행 ID');
  return path.join(P.RUNS, id, 'run.json');
}

function getRun(id) {
  const file = runFile(id);
  if (!fs.existsSync(file)) throw new HttpError(404, `실행 기록을 찾을 수 없습니다: ${id}`);
  return readJson(file);
}

function saveRun(run) {
  writeJson(runFile(run.id), run);
}

function listRuns() {
  if (!fs.existsSync(P.RUNS)) return [];
  return fs.readdirSync(P.RUNS)
    .filter((d) => fs.existsSync(path.join(P.RUNS, d, 'run.json')))
    .map((d) => {
      const r = readJson(path.join(P.RUNS, d, 'run.json'));
      return { id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, label: r.label, platforms: r.platforms, summary: r.summary };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

module.exports = {
  HttpError, readJson, writeJson, assertId,
  listTcs, getTc, saveTc, deleteTc,
  getConfig, getElements, saveElements, getFlows, getTestData, getSchemas,
  getIssues, saveIssues, getHistory, saveHistory,
  getRun, saveRun, listRuns,
};
