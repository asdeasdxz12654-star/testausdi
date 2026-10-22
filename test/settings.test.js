const test = require('node:test');
const assert = require('node:assert');
const settings = require('../server/settings');

const base = {
  project: 'saucedemo 회귀', env: 'demo', baseURL: 'https://www.saucedemo.com', testIdAttribute: 'data-test',
  pc: { device: 'Desktop Chrome', viewport: { width: 1366, height: 768 } },
  mw: { devices: ['Pixel 7'] },
  android: { appId: 'com.example.shop', apkPath: '', serial: '' },
  ios: { appId: 'com.example.shop.ios', agentUrl: '' },
  run: { retries: 1, workers: 2, timeoutMs: 45000, actionTimeoutMs: 10000, expectTimeoutMs: 5000, mobileTimeoutMs: 300000 },
  ai: { model: 'claude-opus-5-5', effort: 'high' },
  exitCriteria: { p1FailMax: 0, criticalOpenMax: 0, flakyRateMax: 0.05, blockedMax: 0 },
  quarantine: { window: 10, flakyThreshold: 3 },
  custom: { keep: true },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test('validate: 정상 값은 합치고, 끝의 / 제거, 모르는 키는 보존', () => {
  const input = clone(base);
  input.baseURL = 'https://qa.myshop.co.kr/';
  input.testIdAttribute = 'data-testid';
  input.mw.devices = ['Galaxy S24', 'iPhone 15'];
  delete input.custom;
  const out = settings.validate(input, base);
  assert.strictEqual(out.baseURL, 'https://qa.myshop.co.kr');
  assert.strictEqual(out.testIdAttribute, 'data-testid');
  assert.deepStrictEqual(out.mw.devices, ['Galaxy S24', 'iPhone 15']);
  assert.deepStrictEqual(out.custom, { keep: true });
});

test('validate: 잘못된 값은 한 번에 모아서 알려준다', () => {
  const input = clone(base);
  input.baseURL = 'qa.myshop.co.kr';
  input.testIdAttribute = 'data test';
  input.pc.device = 'Pixel 7';
  input.mw.devices = ['Desktop Chrome'];
  input.android.appId = 'myshop';
  input.run.retries = 9;
  input.exitCriteria.flakyRateMax = 1.5;
  input.quarantine = { window: 5, flakyThreshold: 6 };
  input.ai.effort = 'turbo';
  assert.throws(() => settings.validate(input, base), (e) => {
    for (const re of [/http/, /식별자 속성/, /PC 기기 프리셋/, /MW 기기 프리셋/, /패키지명/, /재시도/, /Flaky 비율/, /격리 기준/, /생각 깊이/]) assert.match(e.message, re);
    return e.status === 400;
  });
});

test('deviceList: 가로 모드 프리셋은 빼고 PC·모바일을 구분한다', () => {
  const list = settings.deviceList();
  assert.ok(list.some((d) => d.name === 'Desktop Chrome' && !d.mobile));
  assert.ok(list.some((d) => d.name === 'Pixel 7' && d.mobile && d.browser === 'chromium'));
  assert.ok(!list.some((d) => /landscape/i.test(d.name)));
});
