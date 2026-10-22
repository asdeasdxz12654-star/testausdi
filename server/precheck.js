// 실행 전 환경 점검. 하나라도 실패하면 해당 플랫폼 TC는 실행하지 않고 Blocked로 남긴다.
const fs = require('fs');
const { execFile } = require('child_process');
const { chromium, firefox, webkit, devices } = require('@playwright/test');

const BROWSERS = { chromium, firefox, webkit };

function exec(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

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

async function checkAndroid(config) {
  const items = [];
  const adb = await exec('adb', ['devices', '-l']);
  if (!adb.ok && adb.code === 'ENOENT') {
    items.push({ label: 'ADB', ok: false, detail: 'adb가 설치되어 있지 않거나 PATH에 없습니다 (Android SDK Platform-Tools)' });
    return { platform: 'android', items, devices: [] };
  }
  const found = adb.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state] = l.split(/\s+/);
    return { serial, state, model: (l.match(/model:(\S+)/) || [])[1] || serial };
  });
  const ready = found.filter((d) => d.state === 'device');
  items.push({ label: 'ADB', ok: true, detail: '설치됨' });
  if (!ready.length) {
    const unauthorized = found.some((d) => d.state === 'unauthorized');
    items.push({ label: '기기 연결', ok: false, detail: unauthorized ? '기기에서 USB 디버깅 허용을 눌러주세요' : '연결된 기기가 없습니다. USB 디버깅을 켜고 연결하세요' });
  } else {
    const d = ready[0];
    const [ver, power, pkg] = await Promise.all([
      exec('adb', ['-s', d.serial, 'shell', 'getprop', 'ro.build.version.release']),
      exec('adb', ['-s', d.serial, 'shell', 'dumpsys', 'power']),
      exec('adb', ['-s', d.serial, 'shell', 'pm', 'list', 'packages', config.android.appId]),
    ]);
    items.push({ label: '기기 연결', ok: true, detail: `${d.model} · Android ${ver.stdout.trim()}` });
    const awake = /mWakefulness=Awake/.test(power.stdout);
    items.push({ label: '화면 켜짐', ok: awake, detail: awake ? '켜짐' : '화면이 꺼져 있습니다. 화면을 켜고 잠금을 해제하세요' });
    const installed = pkg.stdout.includes(`package:${config.android.appId}`);
    items.push({ label: '앱 설치', ok: installed, detail: installed ? config.android.appId : `${config.android.appId} 앱이 설치되어 있지 않습니다` });
  }
  const maestro = await exec(process.platform === 'win32' ? 'maestro.bat' : 'maestro', ['--version']);
  items.push({ label: 'Maestro', ok: maestro.ok, detail: maestro.ok ? maestro.stdout.trim() : '설치되어 있지 않습니다 (maestro.mobile.dev)' });
  items.push({ label: '실행 어댑터', ok: false, detail: '안드로이드 실행은 다음 단계에서 지원합니다. 지금은 Maestro YAML 생성만 됩니다' });
  return { platform: 'android', items, devices: ready };
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

async function precheck(config, platforms = Object.keys(CHECKS)) {
  const results = await Promise.all(platforms.map((p) => CHECKS[p](config)));
  return results.map((r) => ({ ...r, ok: r.items.every((i) => i.ok), checkedAt: new Date().toISOString() }));
}

module.exports = { precheck };
