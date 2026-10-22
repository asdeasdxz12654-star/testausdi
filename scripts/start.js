// AutoTC 시작 스크립트. AutoTC.exe와 npm start가 이 파일을 실행한다.
// 처음 실행이면 패키지와 Chromium을 설치하고, 서버를 띄운 뒤 브라우저로 콘솔을 연다.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.AUTOTC_PORT) || 4870;
const noOpen = process.argv.includes('--no-open');

const log = (msg) => console.log(`[AutoTC] ${msg}`);

function fail(msg) {
  console.error(`\n[AutoTC] ${msg}`);
  process.exit(1);
}

function runStep(label, cmd, args) {
  log(label);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${label} 실패 (코드 ${r.status}). 인터넷 연결을 확인하고 다시 실행하세요.`);
}

function ensureSetup() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node.js ${process.versions.node}은(는) 지원하지 않습니다. 20 이상을 설치하세요.`);
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '@playwright', 'test'))) {
    runStep('처음 실행: 필요한 패키지를 설치합니다 (1~2분)', 'npm', ['install', '--no-audit', '--no-fund']);
  }
  const { chromium } = require(path.join(ROOT, 'node_modules', '@playwright', 'test'));
  if (!fs.existsSync(chromium.executablePath())) {
    runStep('처음 실행: 테스트용 Chromium 브라우저를 설치합니다 (1~3분)', process.execPath, [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'install', 'chromium']);
  }
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'autotc'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  if (noOpen) return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  console.log('AutoTC 테스트 자동화 실행기');
  ensureSetup();
  if (await ping(PORT)) {
    log(`이미 실행 중입니다. 브라우저로 엽니다: http://127.0.0.1:${PORT}`);
    openBrowser(`http://127.0.0.1:${PORT}`);
    return;
  }
  const { start } = require(path.join(ROOT, 'server'));
  let started;
  try {
    started = await start(PORT);
  } catch (e) {
    if (e.code === 'EADDRINUSE') fail(`${PORT}번 포트를 다른 프로그램이 쓰고 있습니다. 환경변수 AUTOTC_PORT로 다른 포트를 지정하세요.`);
    throw e;
  }
  log(`콘솔: ${started.url}`);
  log('이 창을 닫으면 AutoTC가 종료됩니다.');
  openBrowser(started.url);
}

main().catch((e) => fail(e.stack || e.message));
