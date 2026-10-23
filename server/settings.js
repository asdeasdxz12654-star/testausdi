// 설정 화면: data/config.json 검증·저장, 기기 프리셋 목록, 대상 사이트 접속·식별자 속성 확인.
const path = require('path');
const { chromium, devices } = require('@playwright/test');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const { checkUrl, browserInstalled } = require('./precheck');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

function deviceList() {
  return Object.entries(devices)
    .filter(([name]) => !/landscape/i.test(name))
    .map(([name, d]) => ({ name, mobile: !!d.isMobile, browser: d.defaultBrowserType, width: d.viewport.width, height: d.viewport.height, installed: browserInstalled(d.defaultBrowserType) }));
}

const isUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// 화면에서 온 설정을 검증하고 기존 설정과 합친다. 알 수 없는 키는 그대로 둔다
function validate(input, current) {
  const c = JSON.parse(JSON.stringify(current));
  const e = [];
  const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

  c.project = s(input.project) || c.project;
  c.env = s(input.env);
  if (!isUrl(s(input.baseURL))) e.push('대상 사이트 주소는 http:// 또는 https://로 시작해야 합니다');
  else c.baseURL = s(input.baseURL).replace(/\/+$/, '');
  if (!/^[a-zA-Z][\w-]*$/.test(s(input.testIdAttribute))) e.push('식별자 속성은 영문·숫자·-·_ 만 쓸 수 있습니다 (예: data-testid)');
  else c.testIdAttribute = s(input.testIdAttribute);
  // API 주소는 비우면 대상 사이트 주소를 쓴다
  if (s(input.apiBaseURL) && !isUrl(s(input.apiBaseURL))) e.push('API 주소는 http:// 또는 https://로 시작해야 합니다');
  else if (s(input.apiBaseURL)) c.apiBaseURL = s(input.apiBaseURL).replace(/\/+$/, '');
  else delete c.apiBaseURL;

  const vis = input.visual || {};
  const ratio = Number(vis.maxDiffPixelRatio === undefined ? 0.002 : vis.maxDiffPixelRatio);
  if (!(ratio >= 0 && ratio <= 0.5)) e.push('화면 비교 허용 차이는 0~50%입니다');
  c.visual = { ...c.visual, maxDiffPixelRatio: ratio };

  const roi = input.roi || {};
  const roiKeys = { manualMinutesDefault: [0, 1440], setupHours: [0, 10000], authorMinutesPerTc: [0, 1440], fixMinutesPerIssue: [0, 1440], analysisMinutesPerFailure: [0, 1440] };
  const roiOut = {};
  for (const [k, [min, max]] of Object.entries(roiKeys)) {
    if (roi[k] === undefined || roi[k] === '') continue;
    const v = Number(roi[k]);
    if (!(v >= min && v <= max)) e.push(`ROI 설정 ${k}는 ${min}~${max} 사이 숫자여야 합니다`);
    else roiOut[k] = v;
  }
  c.roi = { ...c.roi, ...roiOut };

  const pc = input.pc || {};
  if (!devices[pc.device] || devices[pc.device].isMobile) e.push(`PC 기기 프리셋이 올바르지 않습니다: ${pc.device}`);
  const vw = Number(pc.viewport && pc.viewport.width);
  const vh = Number(pc.viewport && pc.viewport.height);
  if (!int(vw, 320, 3840) || !int(vh, 320, 2400)) e.push('PC 해상도는 너비 320~3840, 높이 320~2400 사이 정수여야 합니다');
  c.pc = { ...c.pc, device: pc.device, viewport: { width: vw, height: vh } };

  const mw = input.mw || {};
  if (!Array.isArray(mw.devices) || !mw.devices.length) e.push('MW 기기 프리셋을 하나 이상 고르세요');
  else mw.devices.forEach((d) => { if (!devices[d] || !devices[d].isMobile) e.push(`MW 기기 프리셋이 올바르지 않습니다: ${d}`); });
  c.mw = { ...c.mw, devices: mw.devices || [] };

  const an = input.android || {};
  if (s(an.appId) && !/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(s(an.appId))) e.push('안드로이드 패키지명 형식이 올바르지 않습니다 (예: com.example.shop)');
  c.android = { ...c.android, appId: s(an.appId), apkPath: s(an.apkPath), serial: s(an.serial) };
  const io = input.ios || {};
  if (s(io.agentUrl) && !isUrl(s(io.agentUrl))) e.push('Mac 에이전트 주소는 http(s)://로 시작해야 합니다');
  c.ios = { ...c.ios, appId: s(io.appId), agentUrl: s(io.agentUrl) };

  const r = input.run || {};
  const num = (k) => Number(r[k]);
  if (!int(num('retries'), 0, 3)) e.push('재시도 횟수는 0~3');
  if (!int(num('workers'), 1, 8)) e.push('동시 실행 수는 1~8');
  if (!int(num('timeoutMs'), 5000, 600000)) e.push('TC 제한 시간은 5~600초');
  if (!int(num('actionTimeoutMs'), 1000, 120000)) e.push('동작 대기 시간은 1~120초');
  if (!int(num('expectTimeoutMs'), 1000, 60000)) e.push('확인 대기 시간은 1~60초');
  if (!int(num('mobileTimeoutMs'), 30000, 1800000)) e.push('앱 TC 제한 시간은 30~1800초');
  c.run = { ...c.run, ...Object.fromEntries(['retries', 'workers', 'timeoutMs', 'actionTimeoutMs', 'expectTimeoutMs', 'mobileTimeoutMs'].map((k) => [k, num(k)])) };

  const x = input.exitCriteria || {};
  const xc = { p1FailMax: Number(x.p1FailMax), criticalOpenMax: Number(x.criticalOpenMax), flakyRateMax: Number(x.flakyRateMax), blockedMax: Number(x.blockedMax) };
  if (!int(xc.p1FailMax, 0, 1000) || !int(xc.criticalOpenMax, 0, 1000) || !int(xc.blockedMax, 0, 1000)) e.push('종료 기준의 건수는 0 이상 정수여야 합니다');
  if (!(xc.flakyRateMax >= 0 && xc.flakyRateMax <= 1)) e.push('Flaky 비율 기준은 0~100% 사이여야 합니다');
  c.exitCriteria = xc;

  const q = input.quarantine || {};
  const qw = Number(q.window);
  const qt = Number(q.flakyThreshold);
  if (!int(qw, 1, 50) || !int(qt, 1, qw || 1)) e.push('격리 기준: 최근 실행 수는 1~50, Flaky 횟수는 1 이상이고 최근 실행 수 이하');
  c.quarantine = { window: qw, flakyThreshold: qt };

  const a = input.ai || {};
  if (!MODELS.includes(a.model)) e.push(`AI 모델은 ${MODELS.join(', ')} 중 하나여야 합니다`);
  if (!EFFORTS.includes(a.effort)) e.push(`생각 깊이는 ${EFFORTS.join(', ')} 중 하나여야 합니다`);
  c.ai = { ...c.ai, model: a.model, effort: a.effort };

  if (e.length) throw new HttpError(400, e.join('\n'));
  return c;
}

function save(input) {
  const next = validate(input, store.getConfig());
  store.writeJson(path.join(P.DATA, 'config.json'), next);
  return next;
}

// 대상 사이트를 실제 브라우저로 열어 응답과 식별자 속성 사용 현황을 본다 (화면이 스크립트로 그려지는 사이트도 반영)
async function inspectSite(url, { launch = () => chromium.launch() } = {}) {
  if (!isUrl(String(url || '').trim())) throw new HttpError(400, '주소는 http:// 또는 https://로 시작해야 합니다');
  const target = String(url).trim();
  const http = await checkUrl(target);
  if (!http.ok) return { ok: false, message: http.detail, attributes: [] };
  if (!browserInstalled('chromium')) return { ok: true, message: `${http.detail} · 식별자 확인은 Chromium 설치 후 가능`, attributes: [] };
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    const res = await page.goto(target, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => null);
    const title = await page.title().catch(() => '');
    const attributes = await page.evaluate(() => {
      const counts = {};
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.getAttributeNames()) {
          if (/^data-(testid|test-id|test|qa|cy|e2e|automation-id)$/i.test(a) || a === 'id') counts[a] = (counts[a] || 0) + 1;
        }
      }
      return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count);
    });
    return {
      ok: true,
      message: `${http.detail}${res ? '' : ' · 페이지 로딩이 20초 안에 끝나지 않았습니다'}${title ? ` · ${title}` : ''}`,
      attributes,
    };
  } catch (err) {
    return { ok: true, message: `${http.detail} · 브라우저로 열지 못했습니다: ${err.message.split('\n')[0]}`, attributes: [] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { deviceList, validate, save, inspectSite, MODELS, EFFORTS };
