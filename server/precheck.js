// 실행 전 환경 점검. 하나라도 실패하면 해당 플랫폼 TC는 실행하지 않고 Blocked로 남긴다.
const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit, devices } = require('@playwright/test');
const P = require('./paths');
const android = require('./android');

const BROWSERS = { chromium, firefox, webkit };

async function checkUrl(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    return { ok: res.status < 500, detail: `${url} 응답 ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `${url} 접속 실패: ${e.cause ? e.cause.code || e.cause.message : e.message}` };
  }
}

function browserInstalled(type) {
  const b = BROWSERS[type];
  try {
    return b && fs.existsSync(b.executablePath());
  } catch {
    return false;
  }
}

function browserItem(type, forWhat) {
  const ok = browserInstalled(type);
  return { label: `${type} 브라우저`, ok, detail: ok ? `${forWhat}용 설치됨` : `설치 필요: npx playwright install ${type}` };
}

async function checkPc(config) {
  const device = devices[config.pc.device];
  const items = [await checkUrl(config.baseURL).then((r) => ({ label: '테스트 URL', ...r }))];
  if (!device) items.push({ label: '기기 프리셋', ok: false, detail: `알 수 없는 프리셋: ${config.pc.device}` });
  else items.push(browserItem(device.defaultBrowserType, config.pc.device));
  const vp = config.pc.viewport || device.viewport;
  items.push({ label: '해상도', ok: true, detail: `${vp.width}×${vp.height}` });
  return { platform: 'pc', items };
}

async function checkMw(config) {
  const items = [await checkUrl(config.baseURL).then((r) => ({ label: '테스트 URL', ...r }))];
  for (const name of config.mw.devices) {
    const d = devices[name];
    if (!d) { items.push({ label: name, ok: false, detail: '알 수 없는 기기 프리셋' }); continue; }
    items.push({ ...browserItem(d.defaultBrowserType, name), label: `${name} 에뮬레이션` });
  }
  return { platform: 'mw', items };
}

// 통과하면 device(실행에 쓸 기기 정보)를 함께 돌려준다. tools는 테스트에서 가짜 adb/maestro를 넣을 때 쓴다
async function checkAndroid(config, tools) {
  const conf = config.android || {};
  const items = [];
  const { adb, devices: found } = await android.listDevices(tools);
  if (!adb) {
    items.push({ label: 'ADB', ok: false, detail: 'adb가 설치되어 있지 않거나 PATH에 없습니다 (Android SDK Platform-Tools)' });
    return { platform: 'android', items, device: null };
  }
  items.push({ label: 'ADB', ok: true, detail: '설치됨' });
  const ready = found.filter((d) => d.state === 'device');
  const d = conf.serial ? ready.find((x) => x.serial === conf.serial) : ready[0];
  let device = null;
  if (!d) {
    const unauthorized = found.some((x) => x.state === 'unauthorized');
    items.push({
      label: '기기 연결', ok: false,
      detail: conf.serial && ready.length ? `설정한 기기(${conf.serial})가 연결되어 있지 않습니다. 연결된 기기: ${ready.map((x) => x.serial).join(', ')}`
        : unauthorized ? '기기 화면에서 "USB 디버깅 허용"을 눌러주세요'
          : '연결된 기기가 없습니다. USB 디버깅을 켜고 연결하세요',
    });
  } else {
    const info = await android.deviceInfo(d.serial, conf.appId, tools);
    device = { ...d, ...info };
    items.push({ label: '기기 연결', ok: true, detail: `${d.model} · Android ${info.androidVersion}${ready.length > 1 && !conf.serial ? ` (${ready.length}대 중 첫 번째, android.serial로 지정 가능)` : ''}` });
    items.push({ label: '화면 상태', ok: info.awake && !info.locked, detail: !info.awake ? '화면이 꺼져 있습니다. 화면을 켜세요' : info.locked ? '잠금 화면입니다. 잠금을 해제하세요' : '켜짐 · 잠금 해제' });
    const apk = conf.apkPath ? path.resolve(P.ROOT, conf.apkPath) : null;
    if (info.appInstalled) {
      items.push({ label: '앱', ok: true, detail: `${conf.appId} ${info.appVersion || ''}${info.appVersionCode ? ` (${info.appVersionCode})` : ''}${apk ? ' · 실행 전 APK로 재설치' : ''}` });
    } else if (apk && fs.existsSync(apk)) {
      items.push({ label: '앱', ok: true, detail: `설치되어 있지 않음 · 실행 전 ${conf.apkPath} 설치` });
    } else {
      items.push({ label: '앱', ok: false, detail: `${conf.appId} 앱이 설치되어 있지 않습니다${apk ? ` (APK 없음: ${conf.apkPath})` : '. 앱을 설치하거나 android.apkPath를 지정하세요'}` });
    }
  }
  const mv = await android.maestroVersion(tools);
  items.push({ label: 'Maestro', ok: !!mv, detail: mv ? `버전 ${mv}` : '설치되어 있지 않거나 실행되지 않습니다 (Java 17 이상 필요)' });
  return { platform: 'android', items, device };
}

async function checkIos(config) {
  const items = [];
  const url = config.ios && config.ios.agentUrl;
  if (!url) {
    items.push({ label: 'Mac 에이전트', ok: false, detail: '설정되지 않았습니다. 아이폰 실행은 Mac이 필요합니다 (data/config.json의 ios.agentUrl)' });
  } else {
    const r = await checkUrl(`${url.replace(/\/$/, '')}/health`);
    items.push({ label: 'Mac 에이전트', ...r });
  }
  items.push({ label: '실행 어댑터', ok: false, detail: '아이폰 실행은 다음 단계에서 지원합니다. 지금은 Maestro YAML 생성만 됩니다' });
  return { platform: 'ios', items };
}

const CHECKS = { pc: checkPc, mw: checkMw, android: checkAndroid, ios: checkIos };

async function precheck(config, platforms = Object.keys(CHECKS), tools) {
  const results = await Promise.all(platforms.map((p) => CHECKS[p](config, tools)));
  return results.map((r) => ({ ...r, ok: r.items.every((i) => i.ok), checkedAt: new Date().toISOString() }));
}

module.exports = { precheck };
