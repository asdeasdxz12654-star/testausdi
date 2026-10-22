const test = require('node:test');
const assert = require('node:assert');
const { markdownSummary, junitXml } = require('../server/report');
const { parseArgs } = require('../scripts/ci');

const run = {
  id: 'R1', label: '스모크', startedAt: '2026-10-22T03:00:00Z', finishedAt: '2026-10-22T03:00:40Z',
  platforms: ['pc', 'mw'], tcIds: ['TC-1', 'TC-2'],
  results: [
    { key: 'TC-1@pc', tcId: 'TC-1', title: '로그인 <성공> & 진입', platform: 'pc', project: 'pc', device: 'Desktop Chrome', status: 'Pass', durationMs: 1200, classification: {} },
    { key: 'TC-2@pc', tcId: 'TC-2', title: '주문 | 완료', platform: 'pc', project: 'pc', device: 'Desktop Chrome', status: 'Fail', durationMs: 3000, errorType: 'ASSERTION_MISMATCH', error: 'Expected "a"\nReceived "b"', failedStep: { no: 3, title: '3. assertText order.done = 완료' }, classification: { proposed: 'product', confirmed: null }, issueId: 'ISS-0001', knownIssue: false },
    { key: 'TC-2@mw-pixel-7', tcId: 'TC-2', title: '주문 | 완료', platform: 'mw', project: 'mw-pixel-7', device: 'Pixel 7', status: 'Flaky', durationMs: 5000, error: 'Timeout', classification: { proposed: 'flaky' } },
    { key: 'TC-1@mw-pixel-7', tcId: 'TC-1', title: '로그인', platform: 'mw', project: 'mw-pixel-7', device: 'Pixel 7', status: 'Blocked', reason: 'URL 접속 실패', classification: {} },
  ],
  summary: {
    counts: { Pass: 1, Fail: 1, Flaky: 1, Blocked: 1, Skipped: 0 }, passRate: 2 / 3, releasable: false,
    byPlatform: { pc: { Pass: 1, Fail: 1, Flaky: 0, Blocked: 0, Skipped: 0 }, mw: { Pass: 0, Fail: 0, Flaky: 1, Blocked: 1, Skipped: 0 } },
    exit: [{ label: 'P1 Fail', value: 1, max: 0, ok: false }, { label: 'Flaky 비율', value: 1 / 3, max: 0.05, ok: false, percent: true }],
  },
};

test('markdownSummary: 판정, 종료 기준, 문제 결과 표를 만들고 표 구분자를 이스케이프한다', () => {
  const md = markdownSummary(run, [{ id: 'ISS-0001', severity: 'Major' }]);
  assert.match(md, /## AutoTC 스모크 · ❌ 종료 기준 미충족/);
  assert.match(md, /\| 1 \| 1 \| 1 \| 1 \| 0 \| 66\.7% \|/);
  assert.match(md, /❌ Flaky 비율: 33\.3% \(기준 5%\)/);
  assert.match(md, /TC-2 주문 \\\| 완료/);
  assert.match(md, /ISS-0001 \(신규\) Major/);
  assert.match(md, /Blocked \| URL 접속 실패/);
});

test('junitXml: 프로젝트별 testsuite, Fail은 failure, Blocked는 skipped, XML 특수문자 처리', () => {
  const x = junitXml(run);
  assert.match(x, /<testsuites name="AutoTC 스모크" tests="4" failures="1" skipped="1">/);
  assert.match(x, /<testsuite name="mw-pixel-7" tests="2" failures="0" skipped="1"/);
  assert.match(x, /name="TC-1 로그인 &lt;성공&gt; &amp; 진입"/);
  assert.match(x, /classname="pc" name="TC-2/);
  assert.match(x, /classname="mw\.mw-pixel-7"/);
  assert.match(x, /<failure message="3\. assertText order\.done = 완료: Expected &quot;a&quot;" type="ASSERTION_MISMATCH">분류 제안: 제품 결함 의심/);
  assert.match(x, /<skipped message="Blocked: URL 접속 실패"\/>/);
  assert.match(x, /<system-out>Flaky: 재시도 후 통과/);
});

test('parseArgs: 목록 옵션과 잘못된 옵션', () => {
  assert.deepStrictEqual(parseArgs(['--platforms', 'pc, mw', '--tags', 'smoke', '--exclude-tags', 'demo-bug', '--no-gate']),
    { platforms: ['pc', 'mw'], tags: ['smoke'], excludeTags: ['demo-bug'], gate: false });
  assert.throws(() => parseArgs(['--tags']), /--tags 옵션에 값이 필요합니다/);
  assert.throws(() => parseArgs(['--bogus']), /알 수 없는 옵션/);
});
