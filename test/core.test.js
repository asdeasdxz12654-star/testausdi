const test = require('node:test');
const assert = require('node:assert');
const { validateTc, expandSteps, resolveValue, supportOn, describeStep } = require('../server/tc');
const { genPlaywright, genMaestro } = require('../server/generator');
const classify = require('../server/classify');
const issues = require('../server/issues');

const elements = {
  screens: { 'screen.login': { label: '로그인', web: '/' } },
  elements: {
    'login.id': { label: '아이디 입력창', web: { testId: 'username' }, android: { id: 'login_id' }, ios: null },
    'login.submit': { label: '로그인 버튼', web: { role: 'button', name: '로그인' }, android: { id: 'login_submit' }, ios: null },
    'login.error': { label: '에러 문구', web: { css: '.err', nth: 0 }, android: null, ios: null },
  },
};
const flows = { 'flow.login': { label: '로그인', steps: [{ action: 'open', target: 'screen.login' }, { action: 'input', target: 'login.id', value: '{{account.id}}' }] } };
const testData = { account: { id: 'qa_user', password: 'pw!' } };
const config = { android: { appId: 'com.example' }, ios: { appId: 'com.example.ios' } };
const ctx = { elements, flows, testData, config };

const tc = (over = {}) => ({
  id: 'TC-1', title: '로그인 실패', priority: 'P1', platforms: ['pc', 'mw'], precondition: '', tags: [], reqIds: ['LGN-03'],
  steps: [
    { action: 'flow', target: 'flow.login' },
    { action: 'hideKeyboard' },
    { action: 'tap', target: 'login.submit' },
    { action: 'assertText', target: 'login.error', value: '비밀번호 오류' },
  ],
  ...over,
});

test('validateTc: 요소 맵에 없는 대상과 빈 값을 한 번에 알려준다', () => {
  assert.throws(() => validateTc(tc({ steps: [{ action: 'tap', target: 'nope' }, { action: 'input', target: 'login.id' }] }), ctx), (e) => {
    assert.match(e.message, /1번 스텝: 요소 맵에 없는 요소 "nope"/);
    assert.match(e.message, /2번 스텝: 입력 액션은 값이 필요합니다/);
    return e.status === 400;
  });
});

test('expandSteps: 공통 흐름을 펼치고 순번을 다시 매긴다', () => {
  const steps = expandSteps(tc(), flows);
  assert.deepStrictEqual(steps.map((s) => `${s.no}:${s.action}`), ['1:open', '2:input', '3:hideKeyboard', '4:tap', '5:assertText']);
  assert.strictEqual(steps[1].fromFlow, 'flow.login');
});

test('resolveValue: 템플릿을 치환하고 없는 키는 오류', () => {
  assert.strictEqual(resolveValue('{{account.id}}-x', testData), 'qa_user-x');
  assert.throws(() => resolveValue('{{account.none}}', testData), /account.none/);
});

test('supportOn: 플랫폼 미지원 액션을 찾는다', () => {
  const steps = expandSteps(tc({ steps: [{ action: 'hover', target: 'login.submit' }] }), flows);
  assert.deepStrictEqual(supportOn(steps, 'mw'), { ok: false, unsupported: ['hover'] });
  assert.strictEqual(supportOn(steps, 'pc').ok, true);
});

test('describeStep: 템플릿 값은 실제 값 대신 데이터 이름으로 쓴다', () => {
  assert.strictEqual(describeStep({ action: 'input', target: 'login.id', value: '{{account.password}}' }, elements), '아이디 입력창에 테스트 데이터 account.password 입력');
});

test('genPlaywright: PC는 click, MW는 tap과 키보드 닫기', () => {
  const pc = genPlaywright(tc(), 'pc', ctx);
  assert.match(pc, /page\.getByRole\("button", \{ name: "로그인" \}\)\.click\(\)/);
  assert.match(pc, /PC 웹은 가상 키보드가 없어 건너뜀/);
  assert.match(pc, /page\.locator\("\.err"\)\.nth\(0\)\)\.toHaveText\("비밀번호 오류"\)/);
  assert.match(pc, /fill\("qa_user"\)/);
  assert.match(pc, /test\.step\("2\. input login\.id = \{\{account\.id\}\}"/);
  const mw = genPlaywright(tc(), 'mw', ctx);
  assert.match(mw, /\.tap\(\)/);
  assert.match(mw, /document\.activeElement\.blur\(\)/);
});

test('genMaestro: 식별자 미부여 요소를 표시하고 문구로 대체한다', () => {
  const y = genMaestro(tc(), 'android', ctx);
  assert.match(y, /appId: com\.example/);
  assert.match(y, /- tapOn:\n {4}id: "login_submit"/);
  assert.match(y, /식별자 미부여 요소 1개: login\.error/);
  assert.match(y, /- assertVisible: "비밀번호 오류"/);
});

test('errorType: Playwright 오류 문구를 유형으로 나눈다', () => {
  assert.strictEqual(classify.errorType("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByTestId('finish')"), 'ELEMENT_NOT_FOUND');
  assert.strictEqual(classify.errorType('expect(locator).toHaveText(expected) failed\nExpected string: "a"\nReceived: <element(s) not found>'), 'ELEMENT_NOT_FOUND');
  assert.strictEqual(classify.errorType('expect(locator).toHaveText(expected) failed\nExpected string: "a"\nReceived string: "b"'), 'ASSERTION_MISMATCH');
  assert.strictEqual(classify.errorType('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x'), 'NETWORK');
  assert.strictEqual(classify.errorType('strict mode violation: getByText resolved to 2 elements'), 'MULTIPLE_MATCH');
});

const result = (over) => ({ tcId: 'TC-1', platform: 'pc', status: 'Fail', errorType: 'ELEMENT_NOT_FOUND', failedStep: { no: 4, target: 'login.submit' }, ...over });

test('classify: 다른 플랫폼에서 같은 스텝이 통과했으면 스크립트 문제', () => {
  assert.strictEqual(classify.classify(result(), [{ status: 'Pass' }]), 'script');
  assert.strictEqual(classify.classify(result(), [{ status: 'Fail', failedStep: { no: 6 } }]), 'script');
  assert.strictEqual(classify.classify(result(), [{ status: 'Fail', failedStep: { no: 4 } }]), 'product_or_ui');
  assert.strictEqual(classify.classify(result(), [{ status: 'Blocked' }]), 'product_or_ui');
  assert.strictEqual(classify.classify(result({ errorType: 'ASSERTION_MISMATCH' }), []), 'product');
  assert.strictEqual(classify.classify(result({ errorType: 'NETWORK' }), []), 'env');
  assert.strictEqual(classify.classify(result({ status: 'Flaky' }), []), 'flaky');
});

function fakeRun(id, results) {
  return { id, results: results.map((r) => ({ key: `${r.tcId}@${r.platform}`, project: r.platform, classification: { proposed: r.cls || 'product', confirmed: null }, ...r, signature: classify.signature(r) })) };
}

test('applyRun: 같은 시그니처는 하나로 묶고, 수정 완료 후 Pass면 종료, 다시 실패하면 재오픈', () => {
  const tcs = { 'TC-1': { title: '로그인 실패', priority: 'P1' } };
  const list = [];
  const fail = { tcId: 'TC-1', platform: 'pc', status: 'Fail', errorType: 'ASSERTION_MISMATCH', failedStep: { no: 4, target: 'login.error', title: '4. assertText login.error' } };

  issues.applyRun(fakeRun('R1', [fail]), tcs, list);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].id, list[0].type, list[0].severity, list[0].status], ['ISS-0001', 'BUG', 'Major', '신규']);

  const r2 = fakeRun('R2', [fail]);
  issues.applyRun(r2, tcs, list);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].count, 2);
  assert.strictEqual(r2.results[0].knownIssue, true);

  issues.updateIssue(list[0], { status: '수정 완료' });
  issues.applyRun(fakeRun('R3', [{ tcId: 'TC-1', platform: 'pc', status: 'Pass' }]), tcs, list);
  assert.strictEqual(list[0].status, '종료');

  issues.applyRun(fakeRun('R4', [fail]), tcs, list);
  assert.strictEqual(list[0].status, '재오픈');
  assert.strictEqual(list[0].count, 3);
});

test('updateIssue: 유형을 바꾸면 그 유형에 없는 상태·심각도를 정리한다', () => {
  const i = { type: 'BUG', status: '수정중', severity: 'Major', trackerId: '', note: '', history: [] };
  issues.updateIssue(i, { type: 'AUT' });
  assert.deepStrictEqual([i.type, i.status, i.severity], ['AUT', '신규', null]);
  assert.throws(() => issues.updateIssue(i, { severity: 'Major' }), /BUG/);
});

test('isQuarantined: 최근 10회 중 Flaky 3회 이상이면 격리', () => {
  const h = { 'TC-1|pc': ['Flaky', 'Pass', 'Flaky', 'Pass', 'Flaky'].map((status) => ({ status })) };
  assert.strictEqual(issues.isQuarantined(h, 'TC-1|pc', { window: 10, flakyThreshold: 3 }), true);
  assert.strictEqual(issues.isQuarantined(h, 'TC-1|pc', { window: 2, flakyThreshold: 3 }), false);
});
