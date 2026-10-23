// 업계 실무 기능: API 테스트·스키마 검증, 비밀값, 데이터 주도, 화면 비교, 접근성, 요소 수리 제안, 품질 지표, 비밀값 검사
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotc-practices-'));
process.env.AUTOTC_DATA = tmp; // 아래 require보다 먼저 지정해야 store·secrets가 이 폴더를 쓴다

const rt = require('../server/runtime');
const { validateTc, valueParts, resolveValue, secretsUsed, describeStep } = require('../server/tc');
const { genPlaywright, genMaestro } = require('../server/generator');
const secrets = require('../server/secrets');
const heal = require('../server/heal');
const metrics = require('../server/metrics');
const classify = require('../server/classify');
const { scanText, scanJson } = require('../scripts/secret-scan');

const elements = {
  screens: { 'screen.login': { label: '로그인', web: '/' } },
  elements: {
    'login.id': { label: '아이디 입력창', web: { testId: 'username' }, android: { id: 'login_id' } },
    'login.pw': { label: '비밀번호 입력창', web: { testId: 'password' }, android: { id: 'login_pw' } },
    'login.submit': { label: '로그인 버튼', web: { testId: 'login-btn' }, android: { id: 'login_submit' } },
    'login.error': { label: '에러 문구', web: { testId: 'error' }, android: { id: 'login_error' } },
  },
};
const testData = { account: { id: 'qa_user', password: { secret: 'QA_PASSWORD' } } };
const schemas = { post: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } };
const config = { baseURL: 'https://web.example.com', apiBaseURL: 'https://api.example.com', testIdAttribute: 'data-testid', android: { appId: 'com.example' } };
const ctx = { elements, flows: {}, testData, schemas, config };

const tc = (over = {}) => ({ id: 'TC-1', title: '시험', priority: 'P2', platforms: ['api'], precondition: '', tags: [], reqIds: [], steps: [], ...over });

test('runtime: JSON 경로, 기대값 비교 형태, 스키마 검증', () => {
  const body = { data: { items: [{ id: 7, name: '가' }] }, ok: true };
  assert.strictEqual(rt.getPath(body, 'data.items[0].id'), 7);
  assert.strictEqual(rt.getPath([{ t: 'x' }], '[0].t'), 'x');
  assert.strictEqual(rt.getPath(body, 'data.none.id'), undefined);
  assert.deepStrictEqual(rt.compareForm(7, '7'), [7, 7]);
  assert.deepStrictEqual(rt.compareForm(7, '"7"'), ['7', '7']);
  assert.deepStrictEqual(rt.compareForm('가', '가'), ['가', '가']);
  assert.deepStrictEqual(rt.compareForm(undefined, '*'), ['(값 없음)', '(값 있음)']);
  assert.deepStrictEqual(rt.compareForm({ a: 1 }, '{"a":1}'), [{ a: 1 }, { a: 1 }]);

  const schema = { type: 'object', required: ['id', 'title'], properties: { id: { type: 'integer', minimum: 1 }, title: { type: 'string', minLength: 1 }, tags: { type: 'array', items: { enum: ['a', 'b'] } } }, additionalProperties: false };
  assert.deepStrictEqual(rt.validateSchema({ id: 1, title: 't', tags: ['a'] }, schema), []);
  const errs = rt.validateSchema({ id: 0, tags: ['c'], extra: 1 }, schema);
  assert.ok(errs.some((e) => /\$\.title: 필수/.test(e)));
  assert.ok(errs.some((e) => /\$\.id: 1 이상/.test(e)));
  assert.ok(errs.some((e) => /\$\.tags\[0\]/.test(e)));
  assert.ok(errs.some((e) => /\$\.extra: 명세에 없는/.test(e)));
  assert.deepStrictEqual(rt.validateSchema(1.5, { type: 'integer' }), ['$: 타입이 integer이어야 하는데 number']);
});

test('validateTc: API 액션 형식, 스키마 이름, 데이터 행을 검사하고 정리한다', () => {
  assert.throws(() => validateTc(tc({ steps: [{ action: 'apiRequest', value: '/posts' }, { action: 'assertStatus', value: 'OK' }, { action: 'assertSchema', target: 'nope' }, { action: 'saveValue', target: 'id', value: 'new id' }] }), ctx), (e) => {
    assert.match(e.message, /1번 스텝: API 요청은/);
    assert.match(e.message, /2번 스텝: 응답 코드는/);
    assert.match(e.message, /3번 스텝: data\/schemas에 없는 명세/);
    assert.match(e.message, /4번 스텝: 저장 이름은/);
    return true;
  });
  assert.throws(() => validateTc(tc({ steps: [{ action: 'apiRequest', value: 'POST /p', body: '{"a": ' }] }), ctx), /요청 본문이 JSON 형식이 아닙니다/);
  assert.throws(() => validateTc(tc({ steps: [{ action: 'apiRequest', value: 'GET /p/{{row.id}}' }] }), ctx), /데이터 행이 없습니다/);
  assert.throws(() => validateTc(tc({ steps: [{ action: 'apiRequest', value: 'GET /p/{{row.id}}' }], dataSets: [{ name: 'a', values: { id: '1' } }, { name: 'a', values: {} }] }), ctx), (e) => /이름이 겹칩니다/.test(e.message) && /id 값이 없습니다/.test(e.message));

  const ok = validateTc(tc({
    platforms: ['pc'], manualMinutes: '4',
    steps: [{ action: 'open', target: 'screen.login' }, { action: 'assertScreenshot', target: '', value: 'login' }, { action: 'assertA11y', value: '' }],
    dataSets: [{ name: ' 기본 ', values: { n: 1 } }],
  }), ctx);
  assert.deepStrictEqual(ok.steps, [{ action: 'open', target: 'screen.login' }, { action: 'assertScreenshot', value: 'login' }, { action: 'assertA11y' }]);
  assert.deepStrictEqual(ok.dataSets, [{ name: '기본', values: { n: '1' } }]);
  assert.strictEqual(ok.manualMinutes, 4);
  assert.throws(() => validateTc(tc({ platforms: ['pc'], steps: [{ action: 'assertA11y', value: 'high' }] }), ctx), /접근성 검사 값은 critical/);
});

test('값 조각: 비밀값은 이름만, 데이터 행·저장값을 구분한다', () => {
  const row = { name: 'r1', values: { t: 'x"y' } };
  assert.deepStrictEqual(valueParts('{{account.id}}/{{account.password}}/{{row.t}}/{{saved.n}}', testData, row), [
    { lit: 'qa_user', filled: true }, { lit: '/' }, { secret: 'QA_PASSWORD' }, { lit: '/' }, { lit: 'x"y', filled: true }, { lit: '/' }, { saved: 'n' },
  ]);
  assert.throws(() => resolveValue('{{account.password}}', testData), /비밀값 QA_PASSWORD은\(는\) 이 액션에 쓸 수 없습니다/);
  assert.strictEqual(resolveValue('{{account.password}}', testData, { secret: (n) => `<${n}>` }), '<QA_PASSWORD>');
  assert.throws(() => resolveValue('{{row.t}}', testData), /데이터 행이 있는 TC에서만/);
  assert.deepStrictEqual(secretsUsed(tc({ steps: [{ action: 'input', target: 'login.pw', value: '{{account.password}}' }] }), {}, testData), ['QA_PASSWORD']);
});

test('genPlaywright(api): 요청·응답 확인 코드, 비밀값은 실행 때 읽고, 행마다 테스트 하나', () => {
  const t = validateTc(tc({
    steps: [
      { action: 'apiRequest', value: 'POST /login', body: '{"id": "{{row.id}}", "pw": "{{account.password}}"}' },
      { action: 'assertStatus', value: '2xx' },
      { action: 'assertSchema', target: 'post' },
      { action: 'saveValue', target: 'id', value: 'newId' },
      { action: 'apiRequest', value: 'GET /posts/{{saved.newId}}' },
      { action: 'assertJson', target: 'id', value: '{{saved.newId}}' },
    ],
    dataSets: [{ name: '따옴표', values: { id: 'a"b' } }, { name: '일반', values: { id: 'ab' } }],
  }), ctx);
  const code = genPlaywright(t, 'api', ctx);
  assert.strictEqual((code.match(/^test\(/gm) || []).length, 2);
  assert.match(code, /test\("TC-1 시험 \[따옴표\]", async \(\{ request \}, testInfo\)/);
  assert.match(code, /"https:\/\/api\.example\.com" \+ "\/login"/);
  // 행 값의 따옴표는 JSON 안에서 이스케이프된다
  assert.ok(code.includes(String.raw`"a\\\"b"`), '행 값 이스케이프');
  assert.match(code, /JSON\.stringify\(rt\.secret\("QA_PASSWORD"\)\)\.slice\(1, -1\)/);
  assert.match(code, /toMatch\(\/\^2\\d\\d\$\/\)/);
  assert.match(code, /rt\.validateSchema\(body, \{"type":"object"/);
  assert.match(code, /"\/posts\/" \+ String\(vars\["newId"\]\)/);
  assert.match(code, /'x-autotc-trace': trace/);
  assert.ok(!code.includes('afterEach'), 'API는 화면 수리 후보를 모으지 않는다');
});

test('genPlaywright(pc): 비밀값 입력, 화면 비교, 접근성, 실패 시 수리 후보 수집', () => {
  const t = validateTc(tc({
    platforms: ['pc'],
    steps: [
      { action: 'open', target: 'screen.login' },
      { action: 'input', target: 'login.pw', value: '{{account.password}}' },
      { action: 'tap', target: 'login.submit' },
      { action: 'assertScreenshot', target: 'login.error', value: '에러' },
      { action: 'assertA11y', value: 'critical' },
    ],
    dataSets: [{ name: 'a b', values: {} }],
  }), ctx);
  const code = genPlaywright(t, 'pc', ctx);
  assert.match(code, /\.fill\(rt\.secret\("QA_PASSWORD"\)\)/);
  assert.match(code, /expect\(page\.getByTestId\("error"\)\)\.toHaveScreenshot\("에러-a_b\.png"\)/);
  assert.match(code, /rt\.checkA11y\(page, testInfo, "critical"\)/);
  assert.match(code, /const HEAL = \{"login\.pw":\{"testId":"password"\},"login\.submit":\{"testId":"login-btn"\},"login\.error":\{"testId":"error"\}\}/);
  assert.match(code, /collectHealData\(page, testInfo, HEAL, "data-testid"\)/);
  assert.ok(!/qa_pw|secret_value/.test(code));
});

test('genMaestro: 비밀값은 MAESTRO_ 환경변수 자리로, 데이터 행은 첫 행으로 미리보기', () => {
  const t = validateTc(tc({
    platforms: ['android'],
    steps: [{ action: 'open', target: 'screen.login' }, { action: 'input', target: 'login.pw', value: '{{account.password}}' }, { action: 'input', target: 'login.id', value: '{{row.id}}' }],
    dataSets: [{ name: '첫 행', values: { id: 'first' } }, { name: '둘째', values: { id: 'second' } }],
  }), ctx);
  const y = genMaestro(t, 'android', ctx);
  assert.match(y, /inputText: "\$\{MAESTRO_AUTOTC_SECRET_QA_PASSWORD\}"/);
  assert.match(y, /inputText: "first"/);
});

test('secrets: 참조 찾기, 저장, 상태(값은 돌려주지 않음), 없는 이름, 실행 환경변수', () => {
  assert.deepStrictEqual(secrets.refs(testData), { QA_PASSWORD: ['account.password'] });
  assert.throws(() => secrets.save('qa-pw', 'x'), /영문 대문자로 시작/);
  assert.deepStrictEqual(secrets.missing(['QA_PASSWORD'], {}), ['QA_PASSWORD']);
  secrets.save('QA_PASSWORD', 'p@ss');
  const st = secrets.status(testData, {});
  assert.deepStrictEqual(st, [{ name: 'QA_PASSWORD', usedBy: ['account.password'], source: 'saved' }]);
  assert.ok(!JSON.stringify(st).includes('p@ss'));
  assert.strictEqual(secrets.status(testData, { QA_PASSWORD: 'env' })[0].source, 'env');
  assert.strictEqual(secrets.value('QA_PASSWORD', { QA_PASSWORD: 'from-env' }), 'from-env');
  assert.deepStrictEqual(secrets.envFor(['QA_PASSWORD'], {}), { AUTOTC_SECRET_QA_PASSWORD: 'p@ss', MAESTRO_AUTOTC_SECRET_QA_PASSWORD: 'p@ss' });
  process.env.AUTOTC_SECRET_QA_PASSWORD = 'p@ss';
  assert.strictEqual(rt.secret('QA_PASSWORD'), 'p@ss');
  delete process.env.AUTOTC_SECRET_QA_PASSWORD;
  assert.throws(() => rt.secret('QA_PASSWORD'), /비밀값 QA_PASSWORD이\(가\) 없습니다/);
  secrets.remove('QA_PASSWORD');
  assert.deepStrictEqual(secrets.missing(['QA_PASSWORD'], {}), ['QA_PASSWORD']);
});

test('heal: 실패한 요소만, 바뀐 식별자·줄임말은 제안하고 다른 상품 버튼은 제안하지 않는다', () => {
  assert.ok(heal.similarity('login-btn', 'login-button') >= 0.85);
  assert.ok(heal.similarity('add-to-cart-sauce-labs-backpack', 'add-to-cart-sauce-labs-bike-light') < heal.MIN_SCORE);
  const data = {
    missing: ['login.submit', 'login.id'],
    candidates: [
      { testId: 'login-button', tag: 'input', text: 'Login' },
      { testId: 'error-button', tag: 'button', text: 'Dismiss' },
      { testId: 'password', tag: 'input', text: '' }, // 이미 login.pw가 쓰는 식별자
    ],
  };
  const out = heal.suggest(data, elements, 'login.submit');
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].suggestion, { testId: 'login-button' });
  assert.match(out[0].reason, /식별자가 \d+% 비슷한 input "Login"/);
  const none = heal.suggest({ missing: ['login.error'], candidates: [{ testId: 'banner', tag: 'div', text: '' }] }, elements, 'login.error');
  assert.strictEqual(none[0].suggestion, null);
  assert.match(none[0].reason, /제품 확인이 필요/);
});

test('classify: 접근성 위반·화면 차이·기준 없음·비밀값 없음 오류 유형과 분류', () => {
  assert.strictEqual(classify.errorType('Error: 접근성 위반 2종 (serious 이상): label[critical] 3곳'), 'A11Y');
  assert.strictEqual(classify.errorType("Error: A snapshot doesn't exist at /x.png, writing actual."), 'BASELINE_MISSING');
  assert.strictEqual(classify.errorType('Error: Screenshot comparison failed:\n  1200 pixels (ratio 0.02 of all image pixels) are different.'), 'VISUAL_DIFF');
  assert.strictEqual(classify.errorType('Error: 비밀값 QA_PW이(가) 없습니다 (설정 → 비밀값 또는 환경변수 QA_PW)'), 'MISSING_SECRET');
  const r = (errorType) => ({ status: 'Fail', errorType });
  assert.strictEqual(classify.classify(r('A11Y'), []), 'product');
  assert.strictEqual(classify.classify(r('VISUAL_DIFF'), []), 'product_or_ui');
  assert.strictEqual(classify.classify(r('MISSING_SECRET'), []), 'env');
});

test('metrics: ROI, 히스토그램 정렬, 커버리지, 분포 모양, 실패 대 결함', () => {
  const tcs = [
    { id: 'A', title: 'UI', automation: '적합', platforms: ['pc'], reqIds: ['R1'], manualMinutes: 10, steps: [{ action: 'open' }, { action: 'assertVisible' }] },
    { id: 'B', title: 'API', automation: '적합', platforms: ['api'], reqIds: [], steps: [{ action: 'apiRequest' }, { action: 'assertStatus' }] },
    { id: 'C', title: '수동', automation: '수동 유지', platforms: ['pc'], reqIds: ['R2'], steps: [] },
  ];
  const res = (tcId, status, durationMs, issueId) => ({ tcId, status, durationMs, issueId });
  const runs = [
    { id: 'R1', status: 'done', label: '1', startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', summary: { passRate: 0.5, counts: {}, releasable: false }, results: [res('A', 'Fail', 60000, 'ISS-1'), res('B', 'Pass', 0)] },
    { id: 'R2', status: 'done', label: '2', startedAt: '2026-10-02T00:00:00Z', finishedAt: '2026-10-02T00:02:00Z', summary: { passRate: 1, counts: {}, releasable: true }, results: [res('A', 'Pass', 60000), res('B', 'Flaky', 0)] },
  ];
  const issues = [{ id: 'ISS-1', type: 'BUG' }, { id: 'ISS-2', type: 'AUT' }];
  const history = { 'A|pc': [{ status: 'Fail' }, { status: 'Pass' }], 'B|api': [{ status: 'Pass' }, { status: 'Flaky' }, { status: 'Pass' }] };
  const config = { roi: { manualMinutesDefault: 5, setupHours: 1, authorMinutesPerTc: 30, fixMinutesPerIssue: 30, analysisMinutesPerFailure: 10 } };
  const m = metrics.compute({ runs, tcs, issues, history, config });
  // 절감: A (10-1)×2 + B 5×2 = 28분. 투자: 60 + 2×30 + 1×30 + 2×10 = 170분
  assert.strictEqual(m.roi.savedHours, 0.5);
  assert.strictEqual(m.roi.investedHours, 2.8);
  assert.strictEqual(m.roi.ratio, 0.16);
  assert.strictEqual(m.roi.runsToBreakEven, 11);
  assert.strictEqual(m.roi.manualMissing, 1);
  assert.deepStrictEqual(m.stability.map((s) => s.tcId), ['A', 'B']);
  assert.strictEqual(m.coverage.automatedRate, 2 / 3);
  assert.deepStrictEqual(m.coverage.reqsManualOnly, ['R2']);
  assert.deepStrictEqual(m.coverage.withoutReq, ['B']);
  assert.deepStrictEqual(m.distribution.layers, { ui: 1, api: 1 });
  assert.strictEqual(m.distribution.shape, 'pyramid');
  assert.strictEqual(m.quality.failuresToDefects, 1);
  assert.strictEqual(m.quality.flakyRate, 0.25);
  assert.strictEqual(metrics.layerOf({ steps: [{ action: 'flow' }, { action: 'apiRequest' }] }), 'api');
});

test('secret-scan: 키 형식과 데이터 JSON의 평문 비밀번호를 찾고, 참조·허용 표시는 넘어간다', () => {
  assert.deepStrictEqual(scanText('a.js', `const k = '${'sk-ant-'}api03-abcdefghijklmnopqrstu';`).map((f) => f.rule), ['Claude API 키']);
  assert.deepStrictEqual(scanText('a.js', `const k = '${'sk-ant-'}api03-abcdefghijklmnopqrstu'; // secret-scan:allow`), []);
  const found = scanJson('data/testdata.json', JSON.stringify({ account: { id: 'u', password: 'plain' }, admin: { token: { secret: 'ADMIN_TOKEN' } }, tpl: { pw: '{{x.y}}' } }, null, 2));
  assert.deepStrictEqual(found.map((f) => f.rule), ['평문 비밀값 (account.password) → {"secret": "이름"}으로 바꾸세요']);
});

test('describeStep: 새 액션의 결함 초안 문장', () => {
  assert.strictEqual(describeStep({ action: 'apiRequest', value: 'GET /a' }, elements), 'API GET /a 요청');
  assert.strictEqual(describeStep({ action: 'assertJson', target: 'id', value: '{{saved.n}}' }, elements), '응답 id 값이 테스트 데이터 saved.n인지 확인');
  assert.strictEqual(describeStep({ action: 'assertScreenshot', value: 'x' }, elements), '화면 전체를 기준 이미지 "x"와 비교');
  assert.strictEqual(describeStep({ action: 'assertA11y' }, elements), '화면 접근성 검사 (serious 이상 위반 없음)');
});
