const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// AUTOTC_DATA로 다른 데이터 폴더(다른 프로젝트, 테스트용)를 쓸 수 있다
const DATA = process.env.AUTOTC_DATA ? path.resolve(process.env.AUTOTC_DATA) : path.join(ROOT, 'data');
const STATE = path.join(DATA, 'state');

module.exports = {
  ROOT,
  DATA,
  TCS: path.join(DATA, 'tcs'),
  STATE,
  RUNS: path.join(STATE, 'runs'),
  GENERATED: path.join(ROOT, 'generated'),
  WEB: path.join(ROOT, 'web'),
};
