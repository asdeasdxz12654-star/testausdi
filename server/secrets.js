// 비밀값(계정 비밀번호, 토큰). 테스트 데이터에는 {"secret": "이름"}으로 참조만 두고 값은 여기서 받는다.
// 찾는 순서: 환경변수(CI의 GitHub Secrets 등) → data/state/secrets.json(이 PC에서 설정 화면으로 저장, Git 제외)
const path = require('path');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FILE = () => path.join(P.STATE, 'secrets.json');

const isSecretRef = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.secret === 'string';

// 테스트 데이터에서 참조하는 비밀값 이름과 그 위치(account.password 등)
function refs(testData) {
  const out = {};
  const walk = (o, at) => {
    if (isSecretRef(o)) { (out[o.secret] = out[o.secret] || []).push(at); return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, at ? `${at}.${k}` : k);
  };
  walk(testData, '');
  return out;
}

const saved = () => store.readJson(FILE(), {});

function value(name, env = process.env) {
  if (env[name] !== undefined && env[name] !== '') return env[name];
  const s = saved();
  return Object.prototype.hasOwnProperty.call(s, name) ? s[name] : undefined;
}

function status(testData, env = process.env) {
  const used = refs(testData);
  const s = saved();
  const names = [...new Set([...Object.keys(used), ...Object.keys(s)])].sort();
  return names.map((name) => ({
    name,
    usedBy: used[name] || [],
    source: env[name] ? 'env' : Object.prototype.hasOwnProperty.call(s, name) ? 'saved' : null,
  }));
}

function save(name, val) {
  if (!NAME_RE.test(name || '')) throw new HttpError(400, '비밀값 이름은 영문 대문자로 시작하고 대문자·숫자·_ 만 쓸 수 있습니다 (예: QA_ADMIN_PASSWORD)');
  if (typeof val !== 'string' || !val) throw new HttpError(400, '값을 입력하세요');
  const s = saved();
  s[name] = val;
  store.writeJson(FILE(), s);
}

function remove(name) {
  const s = saved();
  if (!Object.prototype.hasOwnProperty.call(s, name)) throw new HttpError(404, `저장된 비밀값이 아닙니다: ${name}`);
  delete s[name];
  store.writeJson(FILE(), s);
}

// 실행 전에 필요한 비밀값이 모두 있는지. 없으면 그 이름들
function missing(names, env = process.env) {
  return names.filter((n) => value(n, env) === undefined);
}

// 실행 프로세스(Playwright, Maestro)에 넘길 환경변수. 스크립트 파일에는 이름만 들어간다
function envFor(names, env = process.env) {
  const out = {};
  for (const n of names) {
    const v = value(n, env);
    if (v === undefined) continue;
    out[`AUTOTC_SECRET_${n}`] = v;
    out[`MAESTRO_AUTOTC_SECRET_${n}`] = v;
  }
  return out;
}

module.exports = { NAME_RE, isSecretRef, refs, value, status, save, remove, missing, envFor };
