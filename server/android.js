// 안드로이드 실행 어댑터. ADB로 기기를 다루고 Maestro로 TC를 실행한 뒤,
// Playwright 리포터와 같은 시도(attempt) 형식으로 결과를 돌려준다.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { stepTitle } = require('./tc');

// ---- 프로세스 실행 ----
// Windows의 maestro는 .bat이라 셸을 거쳐야 한다 (Node 20+는 셸 없이 .bat 실행을 막는다)
const quoteArg = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);

function runProcess(cmd, args = [], { cwd, timeout = 60000, env } = {}) {
  return new Promise((resolve) => {
    const viaShell = process.platform === 'win32' && cmd === 'maestro';
    const fullEnv = env ? { ...process.env, ...env } : undefined;
    let child;
    try {
      child = viaShell
        ? spawn([cmd, ...args].map(quoteArg).join(' '), { cwd, shell: true, windowsHide: true, env: fullEnv })
        : spawn(cmd, args, { cwd, windowsHide: true, env: fullEnv });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 셸 경유 시 명령이 없으면 종료 코드로만 알 수 있다 (cmd: 9009, sh: 127)
      const notFound = viaShell && (code === 9009 || code === 127 || /is not recognized|not found/i.test(stderr) && !stdout);
      resolve({ code, stdout, stderr, timedOut, error: notFound ? Object.assign(new Error(`${cmd}을(를) 찾을 수 없습니다`), { code: 'ENOENT' }) : null });
    });
  });
}

const defaultTools = { run: runProcess };

// ---- 기기 정보 ----
async function listDevices(tools = defaultTools) {
  const r = await tools.run('adb', ['devices', '-l'], { timeout: 10000 });
  if (r.error && r.error.code === 'ENOENT') return { adb: false, devices: [] };
  const devices = r.stdout.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state] = l.split(/\s+/);
    return { serial, state, model: ((l.match(/model:(\S+)/) || [])[1] || serial).replace(/_/g, ' ') };
  });
  return { adb: true, devices };
}

async function deviceInfo(serial, appId, tools = defaultTools) {
  const sh = (...args) => tools.run('adb', ['-s', serial, 'shell', ...args], { timeout: 10000 }).then((r) => r.stdout || '');
  const [version, power, window, pkg] = await Promise.all([
    sh('getprop', 'ro.build.version.release'),
    sh('dumpsys', 'power'),
    sh('dumpsys', 'window'),
    sh('dumpsys', 'package', appId),
  ]);
  const installed = new RegExp(`Package \\[${appId.replace(/\./g, '\\.')}\\]`).test(pkg);
  return {
    androidVersion: version.trim(),
    awake: /mWakefulness=Awake/.test(power),
    locked: /mShowingLockscreen=true|isKeyguardShowing=true|mDreamingLockscreen=true/.test(window),
    appInstalled: installed,
    appVersion: installed ? ((pkg.match(/versionName=(\S+)/) || [])[1] || null) : null,
    appVersionCode: installed ? ((pkg.match(/versionCode=(\d+)/) || [])[1] || null) : null,
  };
}

async function maestroVersion(tools = defaultTools) {
  const r = await tools.run('maestro', ['--version'], { timeout: 30000 });
  if (r.error || r.code !== 0) return null;
  return (r.stdout.trim().split(/\r?\n/).pop() || '').trim() || '설치됨';
}

async function installApk(serial, apkPath, tools = defaultTools) {
  const r = await tools.run('adb', ['-s', serial, 'install', '-r', apkPath], { timeout: 180000 });
  if (r.code !== 0 || !/Success/.test(r.stdout)) throw new Error(`APK 설치 실패: ${(r.stdout + r.stderr).trim().split(/\r?\n/).pop()}`);
}

// ---- 결과 해석 ----
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

function junitFailure(file) {
  if (!fs.existsSync(file)) return null;
  const xml = fs.readFileSync(file, 'utf8');
  const m = xml.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/);
  if (!m) return null;
  const attrs = m[2] || m[5] || '';
  const msg = (attrs.match(/message="([^"]*)"/) || [])[1];
  return unescapeXml((msg || m[3] || '').trim()) || '실패';
}

// Maestro가 config에서 만들어 넣는 내부 명령은 TC 명령 순서 매핑에서 뺀다
const INTERNAL = new Set(['applyConfigurationCommand', 'defineVariablesCommand']);

function readCommands(debugDir) {
  const file = walk(debugDir).find((f) => /commands-.*\.json$/.test(path.basename(f)));
  if (!file) return null;
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return null;
    return list.filter((e) => e && e.command && !INTERNAL.has(Object.keys(e.command)[0]));
  } catch {
    return null;
  }
}

function crashIn(logcat, appId) {
  const esc = appId.replace(/\./g, '\\.');
  const fatal = logcat.match(new RegExp(`FATAL EXCEPTION[^\\n]*\\n(?:[^\\n]*\\n){0,3}?[^\\n]*Process: ${esc}[\\s\\S]{0,1500}`));
  if (fatal) return fatal[0].split('\n').slice(0, 12).join('\n');
  const anr = logcat.match(new RegExp(`ANR in ${esc}[^\\n]*`));
  return anr ? anr[0] : null;
}

function androidErrorType({ message, crash, timedOut, failedKind }) {
  if (crash) return 'CRASH';
  if (timedOut) return 'TIMEOUT';
  if (/device .*(offline|not found|disconnected)|no (connected )?devices|unable to connect|device unauthorized/i.test(message)) return 'DEVICE';
  if (/unable to launch app|not installed|package .* (not found|does not exist)/i.test(message)) return 'APP_LAUNCH';
  if (failedKind === 'value') return 'ASSERTION_MISMATCH';
  if (/element not found|no visible element|assertion is false|not visible|is visible/i.test(message)) return 'ELEMENT_NOT_FOUND';
  return null;
}

// 한 번의 maestro 실행 결과를 스텝 단위로 해석한다
function parseAttempt({ dir, res, commands, steps, appId, logcat }) {
  const passed = res.code === 0 && !res.timedOut && !res.error;
  const failure = junitFailure(path.join(dir, 'junit.xml'));
  const executed = readCommands(path.join(dir, 'debug'));
  const crash = logcat ? crashIn(logcat, appId) : null;
  const tail = `${res.stdout || ''}\n${res.stderr || ''}`.trim().split(/\r?\n/).slice(-15).join('\n');

  // 명령 순서대로 우리 명령 목록과 맞춰 스텝별 상태를 모은다
  const byStep = new Map();
  let failedCmd = null;
  if (executed) {
    executed.forEach((e, i) => {
      const ours = commands[i];
      if (!ours || ours.no === null) return;
      const meta = e.metadata || {};
      if (!['COMPLETED', 'FAILED', 'WARNED'].includes(meta.status)) return;
      const agg = byStep.get(ours.no) || { duration: 0, error: null };
      agg.duration += Number(meta.duration) || 0;
      if (meta.status === 'FAILED' && !agg.error) {
        agg.error = (meta.error && meta.error.message) || failure || '명령 실패';
        failedCmd = failedCmd || ours;
      }
      byStep.set(ours.no, agg);
    });
  } else if (passed) {
    steps.forEach((s) => byStep.set(s.no, { duration: 0, error: null }));
  }
  const stepResults = steps.filter((s) => byStep.has(s.no)).map((s) => ({ title: stepTitle(s), duration: byStep.get(s.no).duration, error: byStep.get(s.no).error }));

  let error = null;
  if (!passed) {
    error = [
      res.timedOut ? 'Maestro 실행 시간 초과' : null,
      res.error ? res.error.message : null,
      failedCmd && byStep.get(failedCmd.no).error,
      !failedCmd ? failure : null,
      crash ? `앱 크래시 감지 (logcat)\n${crash}` : null,
      !failedCmd && !failure && !res.error ? tail : null,
    ].filter(Boolean).join('\n') || 'Maestro 실행 실패';
  }
  return {
    status: passed ? 'passed' : (res.timedOut ? 'timedOut' : 'failed'),
    error,
    errorType: passed ? null : androidErrorType({ message: error, crash, timedOut: res.timedOut, failedKind: failedCmd && failedCmd.kind }),
    steps: stepResults,
    crash,
  };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.txt': 'text/plain', '.log': 'text/plain', '.xml': 'text/plain' };

function attachmentsIn(dir) {
  return walk(dir)
    .filter((f) => /\.(png|jpg|mp4)$/i.test(f) || /(logcat\.txt|maestro\.log)$/.test(f))
    .map((f) => ({ name: path.basename(f) === 'logcat.txt' ? 'logcat' : path.basename(f, path.extname(f)), path: f, contentType: MIME[path.extname(f).toLowerCase()] || 'text/plain' }))
    // 실패 스크린샷을 앞에, 마지막 화면은 그 뒤에 둔다
    .sort((a, b) => (/final/.test(a.name) ? 1 : 0) - (/final/.test(b.name) ? 1 : 0));
}

// TC 하나를 재시도 포함해 실행한다. 반환 형식은 reporter.js의 test 항목과 같다
// env: 비밀값(MAESTRO_AUTOTC_SECRET_*). Maestro는 MAESTRO_로 시작하는 환경변수를 YAML의 ${...}에 채운다
async function runTc({ tc, flow, serial, retries, timeoutMs, outDir, env, tools = defaultTools, log = () => {} }) {
  const attempts = [];
  for (let retry = 0; retry <= retries; retry += 1) {
    const dir = path.join(outDir, `attempt-${retry}`);
    fs.mkdirSync(dir, { recursive: true });
    const yamlFile = path.join(dir, 'flow.yaml');
    fs.writeFileSync(yamlFile, flow.code, 'utf8');
    await tools.run('adb', ['-s', serial, 'logcat', '-c'], { timeout: 10000 });
    log(`[안드로이드] ${tc.id} 실행${retry ? ` (재시도 ${retry})` : ''}`);
    const started = Date.now();
    const res = await tools.run('maestro', ['--device', serial, 'test', yamlFile, '--format', 'junit', '--output', path.join(dir, 'junit.xml'), '--debug-output', path.join(dir, 'debug')], { cwd: dir, timeout: timeoutMs, env });
    const duration = Date.now() - started;
    const lc = await tools.run('adb', ['-s', serial, 'logcat', '-d', '-v', 'time'], { timeout: 20000 });
    const logcat = (lc.stdout || '').split(/\r?\n/).slice(-5000).join('\n');
    fs.writeFileSync(path.join(dir, 'logcat.txt'), logcat, 'utf8');
    const parsed = parseAttempt({ dir, res, commands: flow.commands, steps: flow.steps, appId: flow.appId, logcat });
    attempts.push({ retry, status: parsed.status, duration, error: parsed.error, errorType: parsed.errorType, steps: parsed.steps, attachments: attachmentsIn(dir) });
    log(`[안드로이드] ${tc.id} ${parsed.status === 'passed' ? '통과' : `실패: ${(parsed.error || '').split('\n')[0]}`}`);
    if (parsed.status === 'passed') break;
    if (parsed.errorType === 'DEVICE') break; // 기기 연결 문제는 재시도해도 같은 결과
  }
  const last = attempts[attempts.length - 1];
  const outcome = last.status === 'passed' ? (attempts.length > 1 ? 'flaky' : 'expected') : 'unexpected';
  return { title: `${tc.id} ${tc.title}`, project: 'android', outcome, attempts };
}

module.exports = { runProcess, listDevices, deviceInfo, maestroVersion, installApk, runTc, parseAttempt, crashIn, junitFailure };
