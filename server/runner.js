// 실행 오케스트레이션: 사전 점검 → 스크립트 생성 → Playwright 실행 → 판정 → 분류 → 이슈·이력 반영.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { devices } = require('@playwright/test');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const { PLATFORMS, PLATFORM_LABELS } = require('./actions');
const { expandSteps, supportOn, secretsUsed, rowsOf } = require('./tc');
const { genPlaywright, maestroForRun } = require('./generator');
const { precheck } = require('./precheck');
const android = require('./android');
const classify = require('./classify');
const issuesLib = require('./issues');
const secrets = require('./secrets');
const heal = require('./heal');

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

const apiBase = (config) => config.apiBaseURL || config.baseURL;

// 화면 비교 스텝이 쓰는 기준 이미지 경로 (playwright 설정의 snapshotPathTemplate과 같은 규칙)
function baselineFiles(tc, steps, projectName) {
  const names = steps.filter((s) => s.action === 'assertScreenshot')
    .flatMap((s) => rowsOf(tc).map((row) => `${s.value}${row ? `-${row.name.replace(/[^\w가-힣-]+/g, '_')}` : ''}.png`));
  return names.map((n) => path.join(P.DATA, 'baselines', process.platform, projectName, `${tc.id}.spec.ts`, n));
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
  if (project.platform === 'api') return apiBase(config);
  return PLATFORM_LABELS[project.platform];
}

function selectTcs({ tcIds, tags, excludeTags }) {
  let tcs = store.listTcs().filter((t) => t.automation !== '수동 유지');
  if (tcIds && tcIds.length) tcs = tcs.filter((t) => tcIds.includes(t.id));
  if (tags && tags.length) tcs = tcs.filter((t) => (t.tags || []).some((g) => tags.includes(g)));
  if (excludeTags && excludeTags.length) tcs = tcs.filter((t) => !(t.tags || []).some((g) => excludeTags.includes(g)));
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
    updateBaselines: !!options.updateBaselines,
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

// 실행 폴더의 파일은 /files/, 화면 비교 기준 이미지(data/baselines)는 /baselines/ 로 연다
function fileUrl(abs) {
  const baseDir = path.join(P.DATA, 'baselines');
  if (abs.startsWith(baseDir + path.sep)) return `/baselines/${path.relative(baseDir, abs).split(path.sep).map(encodeURIComponent).join('/')}`;
  return `/files/${path.relative(P.RUNS, abs).split(path.sep).map(encodeURIComponent).join('/')}`;
}

async function execute(run, tcs, tools) {
  const config = store.getConfig();
  const ctx = { config, elements: store.getElements(), flows: store.getFlows(), testData: store.getTestData(), schemas: store.getSchemas() };
  const secretNames = new Set();
  const runDir = path.join(P.RUNS, run.id);
  const genDir = path.join(P.GENERATED, run.id);

  run.precheck = await precheck(config, run.platforms, tools);
  const pre = Object.fromEntries(run.precheck.map((c) => [c.platform, c]));
  run.precheck.forEach((c) => pushLog(run, `[사전 점검] ${PLATFORM_LABELS[c.platform]}: ${c.ok ? '통과' : `실패 - ${c.items.filter((i) => !i.ok).map((i) => i.detail).join(' / ')}`}`));

  run.phase = '스크립트 생성';
  const usedProjects = new Map();
  for (const tc of tcs) {
    const steps = expandSteps(tc, ctx.flows);
    let missingSecrets = [];
    try {
      const used = secretsUsed(tc, ctx.flows, ctx.testData);
      used.forEach((n) => secretNames.add(n));
      missingSecrets = secrets.missing(used);
    } catch { /* 테스트 데이터 오류는 아래 스크립트 변환에서 사유로 남는다 */ }
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
        if (missingSecrets.length) {
          r.status = 'Blocked';
          r.reason = `비밀값이 없습니다: ${missingSecrets.join(', ')} (설정 → 비밀값에서 저장하거나 같은 이름의 환경변수로 넣으세요)`;
          continue;
        }
        if (steps.some((s) => s.action === 'apiRequest')) r.trace = `${run.id}.${tc.id}.${project.name}`;
        if (platform === 'android') {
          try {
            r.androidFlows = rowsOf(tc).map((row) => ({ row, flow: maestroForRun(tc, platform, ctx, row) }));
            r.androidFlows.forEach(({ row, flow }) => {
              const file = path.join(genDir, 'android', `${tc.id}${row ? `-${slug(row.name) || 'row'}` : ''}.yaml`);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, flow.code, 'utf8');
            });
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
          // 화면 비교 기준 이미지가 아직 없는 것: 이번 실행 화면이 기준으로 저장되므로 사람이 확인해야 한다
          const missingBase = baselineFiles(tc, steps, project.name).filter((f) => !fs.existsSync(f));
          if (missingBase.length) r.baselinesMissing = missingBase;
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
    const visual = { maxDiffPixelRatio: 0.002, ...(config.visual || {}) };
    const pwConfig = {
      testDir: genDir,
      outputDir: path.join(runDir, 'artifacts'),
      timeout: config.run.timeoutMs,
      expect: { timeout: config.run.expectTimeoutMs, toHaveScreenshot: { maxDiffPixelRatio: visual.maxDiffPixelRatio, animations: 'disabled' } },
      // 기준 이미지는 Git으로 관리한다. OS마다 글꼴 렌더링이 달라 OS별로 따로 둔다
      snapshotPathTemplate: `${path.join(P.DATA, 'baselines').split(path.sep).join('/')}/{platform}/{projectName}/{testFileName}/{arg}{ext}`,
      updateSnapshots: run.updateBaselines ? 'changed' : 'missing',
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
    await runPlaywright(run, cfgFile, { AUTOTC_RUN_ID: run.id, ...secrets.envFor([...secretNames]) });
    run.phase = '판정';
    const report = store.readJson(reportFile, { tests: [] });
    for (const r of pending) {
      delete r.pending;
      // 데이터 행이 있으면 행마다 테스트가 하나씩 있다 ("TC-ID 제목 [행 이름]")
      const ts = report.tests.filter((x) => x.project === r.project && x.title.startsWith(`${r.tcId} `));
      if (!ts.length) {
        r.status = 'Blocked';
        r.reason = 'Playwright 실행 결과가 없습니다. 실행 로그를 확인하세요';
        continue;
      }
      applyAttempts(r, combineRows(ts));
    }
  }

  const androidPending = run.results.filter((r) => r.androidFlows);
  if (androidPending.length) await runAndroid(run, androidPending, pre.android.device, config, tools, secretNames);

  for (const r of run.results) {
    if (r.baselinesMissing) {
      const created = r.baselinesMissing.filter((f) => fs.existsSync(f));
      if (created.length) {
        r.baselineCreated = created.map((f) => path.relative(P.DATA, f).split(path.sep).join('/'));
        if (r.status === 'Pass') r.reason = `기준 이미지가 없어 이번 실행 화면을 기준으로 저장했습니다 (${r.baselineCreated.join(', ')}). 화면이 맞는지 확인하고, 맞으면 Git에 커밋하세요`;
      }
      delete r.baselinesMissing;
    }
    // 기준 이미지가 없던 화면 비교: 이번 화면을 기준으로 저장했으니 사람이 확인해야 한다 (결함 아님)
    if (r.status === 'Fail' && r.errorType === 'BASELINE_MISSING') {
      r.status = 'Blocked';
      r.reason = '기준 이미지가 없어 이번 실행 화면을 기준으로 저장했습니다 (data/baselines). 저장된 이미지를 확인한 뒤 다시 실행하세요';
    }
    // 요소를 못 찾은 웹 실패: 실패 시점 화면에서 수리 후보를 계산한다 (반영은 사람이)
    if (r.healFile) {
      if (r.errorType === 'ELEMENT_NOT_FOUND') r.heal = heal.suggest(store.readJson(r.healFile, null), ctx.elements, r.failedStep && r.failedStep.target);
      delete r.healFile;
    }
  }

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
async function runAndroid(run, pending, device, config, tools, secretNames = new Set()) {
  const env = secrets.envFor([...secretNames]);
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
      pending.forEach((r) => { delete r.androidFlows; r.status = 'Blocked'; r.reason = e.message; });
      return;
    }
  }
  for (const [i, r] of pending.entries()) {
    run.phase = `안드로이드 실행 (${i + 1}/${pending.length})`;
    const flows = r.androidFlows;
    delete r.androidFlows;
    const tests = [];
    for (const { row, flow } of flows) {
      tests.push(await android.runTc({
        tc: { id: r.tcId, title: `${r.title}${row ? ` [${row.name}]` : ''}` }, flow, serial: device.serial,
        retries: config.run.retries, timeoutMs: config.run.mobileTimeoutMs || 300000, env,
        outDir: path.join(runDir, 'artifacts', `${r.tcId}-android${row ? `-${slug(row.name) || 'row'}` : ''}`), tools, log: (m) => pushLog(run, m),
      }));
    }
    applyAttempts(r, combineRows(tests));
  }
}

const OUTCOME_RANK = { unexpected: 3, flaky: 2, expected: 1, skipped: 0 };
const rowName = (t) => (t.title.match(/\[([^\]]+)\]$/) || [])[1] || null;

// 데이터 행별 결과를 TC 하나의 결과로 합친다. 판정과 증적은 가장 나쁜 행 기준, 시간은 합계
function combineRows(tests) {
  if (tests.length === 1) return tests[0];
  const worst = tests.reduce((a, b) => (OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a));
  return {
    ...worst,
    rows: tests.map((t) => ({ name: rowName(t), status: OUTCOME[t.outcome] || 'Fail', durationMs: t.attempts.reduce((s, a) => s + a.duration, 0) })),
    failedRow: worst.outcome === 'expected' ? null : rowName(worst),
    totalMs: tests.reduce((s, t) => s + t.attempts.reduce((x, a) => x + a.duration, 0), 0),
  };
}

function runPlaywright(run, cfgFile, extraEnv = {}) {
  return new Promise((resolve) => {
    pushLog(run, '[실행] Playwright 시작');
    const child = spawn(process.execPath, [CLI, 'test', '--config', cfgFile], {
      cwd: P.ROOT,
      env: { ...process.env, ...extraEnv, FORCE_COLOR: '0', PW_TEST_HTML_REPORT_OPEN: 'never' },
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
  r.durationMs = t.totalMs || t.attempts.reduce((s, a) => s + a.duration, 0);
  if (t.rows) { r.rows = t.rows; r.failedRow = t.failedRow; }
  // Fail은 마지막 시도, Flaky는 처음 실패한 시도를 근거로 삼는다
  const basis = r.status === 'Flaky' ? t.attempts.find((a) => a.status !== 'passed') : t.attempts[t.attempts.length - 1];
  const files = basis ? basis.attachments : [];
  const healAtt = files.find((a) => a.name === 'autotc-heal');
  if (healAtt) r.healFile = healAtt.path;
  r.attachments = files.filter((a) => a !== healAtt).map((a) => ({ name: a.name, contentType: a.contentType, url: fileUrl(a.path) }));
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
    newBaselines: run.results.filter((r) => r.baselineCreated).length,
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
