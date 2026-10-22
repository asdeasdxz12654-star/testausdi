// 안드로이드 어댑터 테스트. 실제 adb/maestro 대신 가짜 도구로 출력 파일을 만들어 해석·재시도·판정 흐름을 검증한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotc-android-'));
process.env.AUTOTC_DATA = tmp; // 아래 require보다 먼저 지정해야 store가 이 폴더를 쓴다

const android = require('../server/android');
const { maestroForRun } = require('../server/generator');
const runner = require('../server/runner');
const store = require('../server/store');

const APP = 'com.demo.shop';
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };

write(path.join(tmp, 'config.json'), {
  project: 'android test', env: 'test', baseURL: 'http://127.0.0.1:9', testIdAttribute: 'data-test',
  pc: { device: 'Desktop Chrome' }, mw: { devices: ['Pixel 7'] },
  android: { appId: APP, apkPath: '', serial: '' }, ios: { appId: 'x', agentUrl: '' },
  run: { retries: 1, workers: 1, timeoutMs: 1000, actionTimeoutMs: 1000, expectTimeoutMs: 1000, mobileTimeoutMs: 10000 },
  exitCriteria: { p1FailMax: 0, criticalOpenMax: 0, flakyRateMax: 0.05, blockedMax: 0 },
  quarantine: { window: 10, flakyThreshold: 3 },
});
write(path.join(tmp, 'elements.json'), {
  screens: { 'screen.login': { label: '로그인', web: '/' } },
  elements: {
    'login.id': { label: '아이디 입력창', web: { testId: 'id' }, android: { id: 'login_id' }, ios: null },
    'login.submit': { label: '로그인 버튼', web: { testId: 'go' }, android: { id: 'login_submit' }, ios: null },
    'login.error': { label: '에러 문구', web: { testId: 'err' }, android: { id: 'login_error' }, ios: null },
    'home.title': { label: '홈 제목', web: { testId: 'title' }, android: null, ios: null },
  },
});
write(path.join(tmp, 'flows.json'), {});
write(path.join(tmp, 'testdata.json'), { account: { id: 'qa' } });
const tcDef = (id, title, steps) => write(path.join(tmp, 'tcs', `${id}.json`), { id, title, priority: 'P1', automation: '적합', tags: [], reqIds: [], platforms: ['android'], precondition: '', steps });
const loginSteps = (expectText) => [
  { action: 'open', target: 'screen.login' },
  { action: 'input', target: 'login.id', value: '{{account.id}}' },
  { action: 'tap', target: 'login.submit' },
  { action: 'assertText', target: 'login.error', value: expectText },
];
tcDef('TC-A-PASS', '통과', loginSteps('비밀번호 오류'));
tcDef('TC-B-VALUE', '문구 다름', loginSteps('비밀번호 오류'));
tcDef('TC-C-CRASH', '크래시', loginSteps('비밀번호 오류'));
tcDef('TC-D-FLAKY', '한 번 실패 후 통과', loginSteps('비밀번호 오류'));
tcDef('TC-E-NOID', '식별자 미부여', [{ action: 'open', target: 'screen.login' }, { action: 'assertVisible', target: 'home.title' }]);

// ---- 가짜 adb / maestro ----
// flow.yaml의 최상위 "- " 줄을 명령으로 세어 Maestro의 commands-*.json과 같은 모양을 만든다
const flakyCount = {};
const calls = [];
let currentTc = null;
function fakeMaestroTest(args, cwd) {
  const yaml = fs.readFileSync(args[3], 'utf8');
  const tcId = (yaml.match(/^# (TC-\S+)/m) || [])[1];
  currentTc = tcId;
  const blocks = yaml.split(/\r?\n(?=- )/).filter((b) => b.startsWith('- '));
  let failAt = -1;
  let msg = '';
  if (tcId === 'TC-B-VALUE') { failAt = blocks.findIndex((b) => /text:/.test(b)); msg = 'Assertion is false: "login_error" with text "비밀번호 오류" is visible'; }
  if (tcId === 'TC-C-CRASH') { failAt = blocks.findIndex((b) => /tapOn:\s*\n\s*id: "login_submit"/.test(b)) + 1; msg = 'Element not found: Id matching regex: login_error'; }
  if (tcId === 'TC-D-FLAKY') {
    flakyCount[tcId] = (flakyCount[tcId] || 0) + 1;
    if (flakyCount[tcId] === 1) { failAt = blocks.length - 2; msg = 'Element not found: Id matching regex: login_error'; }
  }
  const entries = [{ command: { applyConfigurationCommand: {} }, metadata: { status: 'COMPLETED', duration: 1 } }];
  blocks.forEach((b, i) => {
    if (failAt >= 0 && i > failAt) return;
    entries.push({ command: { [`cmd${i}`]: {} }, metadata: i === failAt ? { status: 'FAILED', duration: 50, error: { message: msg } } : { status: 'COMPLETED', duration: 100 } });
  });
  write(path.join(args[9], 'commands-(flow).json'), entries);
  write(args[7], failAt >= 0 ? `<testsuites><testsuite><testcase name="flow"><failure message="${msg.replace(/"/g, '&quot;')}"/></testcase></testsuite></testsuites>` : '<testsuites><testsuite><testcase name="flow"/></testsuite></testsuites>');
  if (failAt >= 0) write(path.join(args[9], 'screenshot-failed.png'), 'png');
  write(path.join(cwd, 'final.png'), 'png');
  return { code: failAt >= 0 ? 1 : 0, stdout: failAt >= 0 ? 'FAILED' : 'PASSED', stderr: '' };
}

const fakeTools = {
  async run(cmd, args, { cwd } = {}) {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'maestro' && args[0] === '--version') return { code: 0, stdout: '1.39.0\n', stderr: '' };
    // args: --device <serial> test <yaml> --format junit --output <junit> --debug-output <dir>
    if (cmd === 'maestro') return fakeMaestroTest(args, cwd);
    if (cmd === 'adb' && args[0] === 'devices') return { code: 0, stdout: 'List of devices attached\nR3CT80 device product:x model:Galaxy_S23 device:y\n\n', stderr: '' };
    const sh = args.slice(3).join(' ');
    if (sh.startsWith('getprop')) return { code: 0, stdout: '14\n' };
    if (sh === 'dumpsys power') return { code: 0, stdout: 'mWakefulness=Awake\n' };
    if (sh === 'dumpsys window') return { code: 0, stdout: 'mShowingLockscreen=false\n' };
    if (sh.startsWith('dumpsys package')) return { code: 0, stdout: `Packages:\n  Package [${APP}] (abc):\n    versionCode=318 minSdk=26\n    versionName=2.14.0\n` };
    if (args.includes('logcat') && args.includes('-d')) {
      const crash = currentTc === 'TC-C-CRASH'
        ? `10-22 11:00:00.000 E/AndroidRuntime( 4321): FATAL EXCEPTION: main\n10-22 11:00:00.000 E/AndroidRuntime( 4321): Process: ${APP}, PID: 4321\n10-22 11:00:00.000 E/AndroidRuntime( 4321): java.lang.NullPointerException: user is null\n`
        : '10-22 11:00:00.000 I/ActivityManager( 100): Start proc\n';
      return { code: 0, stdout: crash };
    }
    return { code: 0, stdout: '', stderr: '' };
  },
};

function runAndWait(options) {
  return new Promise((resolve) => runner.startRun(options, { tools: fakeTools, onDone: resolve }));
}

test('maestroForRun: 명령마다 스텝 번호와 종류를 기록하고 입력 전에 지운다', () => {
  const ctx = { config: store.getConfig(), elements: store.getElements(), flows: {}, testData: store.getTestData() };
  const flow = maestroForRun(store.getTc('TC-A-PASS'), 'android', ctx);
  assert.deepStrictEqual(flow.commands.map((c) => `${c.no}:${c.kind}`), ['1:action', '2:action', '2:action', '2:action', '3:action', '4:presence', '4:value', 'null:meta']);
  assert.match(flow.code, /- eraseText\n- inputText: "qa"/);
  assert.throws(() => maestroForRun(store.getTc('TC-E-NOID'), 'android', ctx), /home\.title 요소에 안드로이드 식별자가 없습니다/);
});

test('crashIn: 대상 앱의 FATAL EXCEPTION만 잡는다', () => {
  const other = 'E/AndroidRuntime: FATAL EXCEPTION: main\nE/AndroidRuntime: Process: com.other.app, PID: 1\n';
  assert.strictEqual(android.crashIn(other, APP), null);
  assert.match(android.crashIn(`E/AndroidRuntime: FATAL EXCEPTION: main\nE/AndroidRuntime: Process: ${APP}, PID: 1\nNPE`, APP), /Process: com\.demo\.shop/);
});

test('실행: 판정, 실패 스텝 매핑, 오류 유형, Flaky, Blocked, 이슈 생성', async () => {
  const run = await runAndWait({ platforms: ['android'] });
  assert.strictEqual(run.status, 'done', run.error);
  const by = Object.fromEntries(run.results.map((r) => [r.tcId, r]));

  assert.strictEqual(by['TC-A-PASS'].status, 'Pass');
  assert.strictEqual(by['TC-A-PASS'].device, 'Galaxy S23 · Android 14 · 앱 2.14.0 (318)');
  assert.strictEqual(by['TC-A-PASS'].attempts[0].steps.length, 4);

  const b = by['TC-B-VALUE'];
  assert.strictEqual(b.status, 'Fail');
  assert.strictEqual(b.attempts.length, 2);
  assert.strictEqual(b.failedStep.no, 4);
  assert.strictEqual(b.errorType, 'ASSERTION_MISMATCH');
  assert.strictEqual(b.classification.proposed, 'product');
  assert.ok(b.attachments.some((a) => a.name === 'logcat'));
  assert.ok(b.attachments[0].name === 'screenshot-failed', '실패 스크린샷이 첫 첨부');

  const c = by['TC-C-CRASH'];
  assert.strictEqual(c.errorType, 'CRASH');
  assert.strictEqual(c.failedStep.no, 4);
  assert.match(c.error, /NullPointerException/);
  assert.strictEqual(c.classification.proposed, 'product');

  assert.strictEqual(by['TC-D-FLAKY'].status, 'Flaky');
  assert.strictEqual(by['TC-D-FLAKY'].classification.proposed, 'flaky');

  assert.strictEqual(by['TC-E-NOID'].status, 'Blocked');
  assert.match(by['TC-E-NOID'].reason, /식별자가 없습니다/);

  const issues = store.getIssues();
  const crashIssue = issues.find((i) => i.tcId === 'TC-C-CRASH');
  assert.strictEqual(crashIssue.severity, 'Critical');
  assert.deepStrictEqual(issues.map((i) => i.type).sort(), ['BUG', 'BUG', 'FLK']);
  assert.match(b.defectDraft, /환경: Galaxy S23 · Android 14 · 앱 2\.14\.0 \(318\) · com\.demo\.shop/);

  assert.ok(calls.some((c2) => c2.startsWith('maestro --device R3CT80 test')), '기기를 지정해 실행');
});

test('사전 점검 실패 시 실행하지 않고 Blocked', async () => {
  const noDevice = { run: async (cmd, args) => (cmd === 'adb' && args[0] === 'devices' ? { code: 0, stdout: 'List of devices attached\nR3CT80 unauthorized\n' } : fakeTools.run(cmd, args)) };
  const run = await new Promise((resolve) => runner.startRun({ platforms: ['android'], tcIds: ['TC-A-PASS'] }, { tools: noDevice, onDone: resolve }));
  assert.strictEqual(run.results[0].status, 'Blocked');
  assert.match(run.results[0].reason, /USB 디버깅 허용/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
