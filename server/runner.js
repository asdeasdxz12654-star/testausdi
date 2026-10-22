// 실행 오케스트레이션: 사전 점검 → 스크립트 생성 → Playwright 실행 → 판정 → 분류 → 이슈·이력 반영.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { devices } = require('@playwright/test');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const { PLATFORMS, PLATFORM_LABELS } = require('./actions');
const { expandSteps, supportOn } = require('./tc');
const { genPlaywright, maestroForRun } = require('./generator');
const { precheck } = require('./precheck');
const android = require('./android');
const classify = require('./classify');
const issuesLib = require('./issues');

const CLI = require.resolve('@playwright/test/cli');
const LOG_LIMIT = 400;

let current = null;

const getCurrent = () => current;

function newRunId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `R${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// 플랫폼 하나가 여러 실행 단위(프로젝트)로 나뉠 수 있다. MW는 기기 프리셋마다 하나
function projectsFor(platform, config) {
  if (platform === 'pc') return [{ name: 'pc', platform, device: config.pc.device }];
  if (platform === 'mw') return config.mw.devices.map((d) => ({ name: `mw-${slug(d)}`, platform, device: d }));
  return [{ name: platform, platform, device: null }];
}

function androidLabel(device) {
  if (!device) return PLATFORM_LABELS.android;
  return `${device.model} · Android ${device.androidVersion}${device.appVersion ? ` · 앱 ${device.appVersion}${device.appVersionCode ? ` (${device.appVersionCode})` : ''}` : ''}`;
}

function deviceLabel(project, config) {
  if (project.platform === 'pc') {
    const vp = config.pc.viewport || devices[project.device].viewport;
    return `${project.device} ${vp.width}×${vp.height}`;
  }
  if (project.platform === 'mw') {
    const d = devices[project.device];
    return d ? `${project.device} 에뮬레이션 ${d.viewport.width}×${d.viewport.height}` : project.device;
  }
  return PLATFORM_LABELS[project.platform];
}

function selectTcs({ tcIds, tags }) {
  let tcs = store.listTcs().filter((t) => t.automation !== '수동 유지');
  if (tcIds && tcIds.length) tcs = tcs.filter((t) => tcIds.includes(t.id));
  if (tags && tags.length) tcs = tcs.filter((t) => (t.tags || []).some((g) => tags.includes(g)));
  return tcs;
}

// deps.tools: 테스트에서 가짜 adb/maestro를 넣을 때 쓴다. deps.onDone: 실행이 끝나면 호출
function startRun(options = {}, deps = {}) {
  if (current) throw new HttpError(409, `이미 실행 중입니다 (${current.id}). 끝난 뒤 다시 시도하세요`);
  const platforms = (options.platforms || []).filter((p) => PLATFORMS.includes(p));
  if (!platforms.length) throw new HttpError(400, '실행할 플랫폼을 하나 이상 고르세요');
  const tcs = selectTcs(options);
  if (!tcs.length) throw new HttpError(400, '조건에 맞는 자동화 TC가 없습니다');
  let id = newRunId();
  while (fs.existsSync(path.join(P.RUNS, id))) id += 'x';
  const run = {
    id,
    label: options.label || (options.tags && options.tags.length ? `@${options.tags.join(' @')}` : options.tcIds ? '선택 실행' : '전체 실행'),
    status: 'running',
    phase: '사전 점검',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    platforms,
    tcIds: tcs.map((t) => t.id),
    precheck: [],
    results: [],
    log: [],
  };
  store.saveRun(run);
  current = run;
  execute(run, tcs, deps.tools).catch((e) => {
    run.status = 'error';
    run.error = e.message;
    pushLog(run, `오류: ${e.stack || e.message}`);
  }).finally(() => {
    run.finishedAt = new Date().toISOString();
    run.phase = null;
    store.saveRun(run);
    current = null;
    if (deps.onDone) deps.onDone(run);
  });
  return run;
}

function pushLog(run, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    run.log.push(line);
  }
  if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
}

function fileUrl(abs) {
  return `/files/${path.relative(P.RUNS, abs).split(path.sep).map(encodeURIComponent).join('/')}`;
}

async function execute(run, tcs, tools) {
  const config = store.getConfig();
  const ctx = { config, elements: store.getElements(), flows: store.getFlows(), testData: store.getTestData() };
  const runDir = path.join(P.RUNS, run.id);
  const genDir = path.join(P.GENERATED, run.id);

  run.precheck = await precheck(config, run.platforms, tools);
  const pre = Object.fromEntries(run.precheck.map((c) => [c.platform, c]));
  run.precheck.forEach((c) => pushLog(run, `[사전 점검] ${PLATFORM_LABELS[c.platform]}: ${c.ok ? '통과' : `실패 - ${c.items.filter((i) => !i.ok).map((i) => i.detail).join(' / ')}`}`));

  run.phase = '스크립트 생성';
  const usedProjects = new Map();
  for (const tc of tcs) {
    const steps = expandSteps(tc, ctx.flows);
    for (const platform of run.platforms.filter((p) => tc.platforms.includes(p))) {
      for (const project of projectsFor(platform, config)) {
        const r = {
          key: `${tc.id}@${project.name}`,
          tcId: tc.id, title: tc.title, priority: tc.priority, platform, project: project.name,
          device: platform === 'android' ? androidLabel(pre.android && pre.android.device) : deviceLabel(project, config),
          status: null, reason: null, attempts: [], attachments: [],
          failedStep: null, error: null, errorType: null,
          classification: { proposed: null, confirmed: null },
          issueId: null, knownIssue: false, quarantined: false, defectDraft: null, durationMs: 0,
        };
        run.results.push(r);
        if (!pre[platform].ok) {
          r.status = 'Blocked';
          r.reason = pre[platform].items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`).join(' / ');
          continue;
        }
        const support = supportOn(steps, platform);
        if (!support.ok) {
          r.status = 'Skipped';
          r.reason = `${PLATFORM_LABELS[platform]}에서 지원하지 않는 액션: ${support.unsupported.join(', ')}`;
          continue;
        }
        if (platform === 'android') {
          try {
            r.androidFlow = maestroForRun(tc, platform, ctx);
            const file = path.join(genDir, 'android', `${tc.id}.yaml`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, r.androidFlow.code, 'utf8');
          } catch (e) {
            r.status = 'Blocked';
            r.reason = `스크립트 변환 실패: ${e.message}`;
          }
          continue;
        }
        try {
          const code = genPlaywright(tc, platform, ctx);
          const file = path.join(genDir, project.name, `${tc.id}.spec.ts`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, code, 'utf8');
          usedProjects.set(project.name, project);
          r.pending = true;
        } catch (e) {
          r.status = 'Blocked';
          r.reason = `스크립트 변환 실패: ${e.message}`;
        }
      }
    }
  }

  const pending = run.results.filter((r) => r.pending);
  if (pending.length) {
    run.phase = `실행 중 (${pending.length}건)`;
    const reportFile = path.join(runDir, 'playwright-results.json');
    const cfgFile = path.join(genDir, 'playwright.config.js');
    const pwConfig = {
      testDir: genDir,
      outputDir: path.join(runDir, 'artifacts'),
      timeout: config.run.timeoutMs,
      expect: { timeout: config.run.expectTimeoutMs },
      retries: config.run.retries,
      workers: config.run.workers,
      fullyParallel: true,
      reporter: [['list'], [path.join(__dirname, 'reporter.js'), { outputFile: reportFile }], ['html', { outputFolder: path.join(runDir, 'html-report'), open: 'never' }]],
      use: {
        baseURL: config.baseURL,
        testIdAttribute: config.testIdAttribute,
        actionTimeout: config.run.actionTimeoutMs,
        navigationTimeout: 20000,
        screenshot: 'on',
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
        locale: 'ko-KR',
      },
      projects: [...usedProjects.values()].map((p) => ({
        name: p.name,
        testDir: path.join(genDir, p.name),
        use: { ...devices[p.device], ...(p.platform === 'pc' && config.pc.viewport ? { viewport: config.pc.viewport } : {}) },
      })),
    };
    fs.mkdirSync(genDir, { recursive: true });
    fs.writeFileSync(cfgFile, `// 자동 생성 파일 (${run.id})\nmodule.exports = ${JSON.stringify(pwConfig, null, 2)};\n`, 'utf8');
    await runPlaywright(run, cfgFile);
    run.phase = '판정';
    const report = store.readJson(reportFile, { tests: [] });
    for (const r of pending) {
      delete r.pending;
      const t = report.tests.find((x) => x.project === r.project && x.title.startsWith(`${r.tcId} `));
      if (!t) {
        r.status = 'Blocked';
        r.reason = 'Playwright 실행 결과가 없습니다. 실행 로그를 확인하세요';
        continue;
      }
      applyAttempts(r, t);
    }
  }

  const androidPending = run.results.filter((r) => r.androidFlow);
  if (androidPending.length) await runAndroid(run, androidPending, pre.android.device, config, tools);

  // 같은 TC의 다른 플랫폼 결과와 비교해 분류
  const tcsById = Object.fromEntries(tcs.map((t) => [t.id, t]));
  for (const r of run.results) {
    if (r.status !== 'Fail' && r.status !== 'Flaky') continue;
    const others = run.results.filter((o) => o.tcId === r.tcId && o.key !== r.key);
    r.classification.proposed = classify.classify(r, others);
    r.signature = classify.signature(r);
    const tc = tcsById[r.tcId];
    r.defectDraft = classify.defectDraft(r, { tc, steps: expandSteps(tc, ctx.flows), elements: ctx.elements, deviceLabel: r.device, baseURL: r.platform === 'android' ? config.android.appId : config.baseURL, others });
  }

  const history = issuesLib.updateHistory(store.getHistory(), run);
  run.results.forEach((r) => { r.quarantined = issuesLib.isQuarantined(history, `${r.tcId}|${r.project}`, config.quarantine); });
  store.saveHistory(history);

  const issues = issuesLib.applyRun(run, tcsById, store.getIssues());
  store.saveIssues(issues);

  run.htmlReport = fs.existsSync(path.join(runDir, 'html-report', 'index.html')) ? fileUrl(path.join(runDir, 'html-report', 'index.html')) : null;
  run.summary = summarize(run, issues, config);
  run.status = 'done';
  pushLog(run, `[완료] Pass ${run.summary.counts.Pass} · Fail ${run.summary.counts.Fail} · Flaky ${run.summary.counts.Flaky} · Blocked ${run.summary.counts.Blocked} · Skipped ${run.summary.counts.Skipped}`);
}

// 안드로이드는 기기 한 대에서 TC를 하나씩 실행한다. APK가 지정돼 있으면 먼저 설치한다
async function runAndroid(run, pending, device, config, tools) {
  const conf = config.android || {};
  const runDir = path.join(P.RUNS, run.id);
  if (conf.apkPath) {
    run.phase = '안드로이드 앱 설치';
    pushLog(run, `[안드로이드] ${conf.apkPath} 설치`);
    try {
      await android.installApk(device.serial, path.resolve(P.ROOT, conf.apkPath), tools);
      const info = await android.deviceInfo(device.serial, conf.appId, tools);
      Object.assign(device, info);
      pending.forEach((r) => { r.device = androidLabel(device); });
    } catch (e) {
      pushLog(run, `[안드로이드] ${e.message}`);
      pending.forEach((r) => { delete r.androidFlow; r.status = 'Blocked'; r.reason = e.message; });
      return;
    }
  }
  for (const [i, r] of pending.entries()) {
    run.phase = `안드로이드 실행 (${i + 1}/${pending.length})`;
    const flow = r.androidFlow;
    delete r.androidFlow;
    const t = await android.runTc({
      tc: { id: r.tcId, title: r.title }, flow, serial: device.serial,
      retries: config.run.retries, timeoutMs: config.run.mobileTimeoutMs || 300000,
      outDir: path.join(runDir, 'artifacts', `${r.tcId}-android`), tools, log: (m) => pushLog(run, m),
    });
    applyAttempts(r, t);
  }
}

function runPlaywright(run, cfgFile) {
  return new Promise((resolve) => {
    pushLog(run, '[실행] Playwright 시작');
    const child = spawn(process.execPath, [CLI, 'test', '--config', cfgFile], {
      cwd: P.ROOT,
      env: { ...process.env, FORCE_COLOR: '0', PW_TEST_HTML_REPORT_OPEN: 'never' },
      windowsHide: true,
    });
    child.stdout.on('data', (d) => pushLog(run, d));
    child.stderr.on('data', (d) => pushLog(run, d));
    child.on('error', (e) => { pushLog(run, `Playwright 실행 실패: ${e.message}`); resolve(); });
    child.on('close', (code) => { pushLog(run, `[실행] Playwright 종료 (코드 ${code})`); resolve(); });
  });
}

const OUTCOME = { expected: 'Pass', flaky: 'Flaky', unexpected: 'Fail', skipped: 'Skipped' };

function applyAttempts(r, t) {
  r.status = OUTCOME[t.outcome] || 'Fail';
  r.attempts = t.attempts.map((a) => ({ retry: a.retry, status: a.status, durationMs: a.duration, error: a.error, steps: a.steps }));
  r.durationMs = t.attempts.reduce((s, a) => s + a.duration, 0);
  // Fail은 마지막 시도, Flaky는 처음 실패한 시도를 근거로 삼는다
  const basis = r.status === 'Flaky' ? t.attempts.find((a) => a.status !== 'passed') : t.attempts[t.attempts.length - 1];
  r.attachments = (basis ? basis.attachments : []).map((a) => ({ name: a.name, contentType: a.contentType, url: fileUrl(a.path) }));
  if (r.status === 'Fail' || r.status === 'Flaky') {
    r.failedStep = classify.failedStep(basis);
    r.error = basis.error;
    // 안드로이드 어댑터는 logcat·명령 종류로 판단한 오류 유형을 함께 준다
    r.errorType = basis.errorType || classify.errorType((r.failedStep && r.failedStep.error) || basis.error);
  }
}

function summarize(run, issues, config) {
  const empty = () => ({ Pass: 0, Fail: 0, Flaky: 0, Blocked: 0, Skipped: 0 });
  const counts = empty();
  const byPlatform = Object.fromEntries(run.platforms.map((p) => [p, empty()]));
  const classifications = {};
  let p1Fail = 0;
  let executed = 0;
  let quarantined = 0;
  for (const r of run.results) {
    if (!r.status) continue;
    counts[r.status] += 1;
    byPlatform[r.platform][r.status] += 1;
    if (r.quarantined) { quarantined += 1; continue; }
    if (['Pass', 'Fail', 'Flaky'].includes(r.status)) executed += 1;
    if (r.status === 'Fail' && r.priority === 'P1') p1Fail += 1;
    if (r.status === 'Fail' || r.status === 'Flaky') {
      const c = r.classification.confirmed || r.classification.proposed;
      classifications[c] = (classifications[c] || 0) + 1;
    }
  }
  const passCount = run.results.filter((r) => !r.quarantined && (r.status === 'Pass' || r.status === 'Flaky')).length;
  const flakyCount = run.results.filter((r) => !r.quarantined && r.status === 'Flaky').length;
  const ec = config.exitCriteria;
  const criticalOpen = issues.filter((i) => i.type === 'BUG' && i.severity === 'Critical' && i.status !== '종료').length;
  const flakyRate = executed ? flakyCount / executed : 0;
  const exit = [
    { label: 'P1 Fail', value: p1Fail, max: ec.p1FailMax, ok: p1Fail <= ec.p1FailMax },
    { label: '미해결 Critical 결함', value: criticalOpen, max: ec.criticalOpenMax, ok: criticalOpen <= ec.criticalOpenMax },
    { label: 'Flaky 비율', value: flakyRate, max: ec.flakyRateMax, ok: flakyRate <= ec.flakyRateMax, percent: true },
    { label: 'Blocked', value: counts.Blocked, max: ec.blockedMax, ok: counts.Blocked <= ec.blockedMax },
  ];
  return {
    counts, byPlatform, classifications, executed, quarantined,
    passRate: executed ? passCount / executed : null,
    exit, releasable: exit.every((e) => e.ok),
  };
}

// 실행 상세 조회 시 분류 확정·이슈 변경을 반영해 요약을 다시 계산한다
function withSummary(run) {
  if (run.status !== 'done') return run;
  return { ...run, summary: summarize(run, store.getIssues(), store.getConfig()) };
}

module.exports = { startRun, getCurrent, withSummary, summarize, projectsFor };
