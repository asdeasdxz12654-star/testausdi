const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
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
