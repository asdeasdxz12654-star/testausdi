// 화면 없이 실행하는 명령줄 모드 (CI용).
// 예) npm run ci -- --platforms pc,mw --tags smoke --exclude-tags demo-bug
// 종료 코드: 0 종료 기준 충족, 1 미충족, 2 실행 오류·잘못된 옵션
const fs = require('fs');
const path = require('path');

const HELP = `사용법: npm run ci -- [옵션]
  --platforms pc,mw        실행할 플랫폼 (기본 pc,mw)
  --tags smoke             이 태그가 붙은 TC만 실행
  --exclude-tags demo-bug  이 태그가 붙은 TC는 제외
  --tc TC-LOGIN-001,...    지정한 TC만 실행
  --label "야간 회귀"       실행 이름
  --out <폴더>             summary.md, junit.xml을 복사할 폴더
  --no-gate                종료 기준을 못 맞춰도 종료 코드 0 (리포트만 필요할 때)`;

function parseArgs(argv) {
  const opts = { platforms: ['pc', 'mw'], gate: true };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 옵션에 값이 필요합니다`);
      i += 1;
      return v;
    };
    if (a === '--platforms') opts.platforms = list(next());
    else if (a === '--tags') opts.tags = list(next());
    else if (a === '--exclude-tags') opts.excludeTags = list(next());
    else if (a === '--tc') opts.tcIds = list(next());
    else if (a === '--label') opts.label = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--no-gate') opts.gate = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

async function notifySlack(url, run) {
  // 슬랙 수신 웹훅. 실패해도 실행 결과에는 영향을 주지 않는다
  const sm = run.summary;
  const text = [
    `${sm.releasable ? ':white_check_mark:' : ':x:'} AutoTC ${run.label} · ${sm.releasable ? '종료 기준 충족' : '종료 기준 미충족'}`,
    `Pass ${sm.counts.Pass} · Fail ${sm.counts.Fail} · Flaky ${sm.counts.Flaky} · Blocked ${sm.counts.Blocked}`,
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  ].filter(Boolean).join('\n');
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
    console.log(`[AutoTC] 슬랙 알림 ${res.ok ? '보냄' : `실패 (${res.status})`}`);
  } catch (e) {
    console.log(`[AutoTC] 슬랙 알림 실패: ${e.message}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[AutoTC] ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }

  const runner = require('../server/runner');
  const store = require('../server/store');
  const report = require('../server/report');
  const P = require('../server/paths');

  let run;
  try {
    run = await new Promise((resolve, reject) => {
      try {
        const started = runner.startRun({ platforms: opts.platforms, tags: opts.tags, excludeTags: opts.excludeTags, tcIds: opts.tcIds, label: opts.label }, { onDone: resolve });
        console.log(`[AutoTC] 실행 시작 ${started.id} · ${started.label} · TC ${started.tcIds.length}건 · ${opts.platforms.join(', ')}`);
      } catch (e) { reject(e); }
    });
  } catch (e) {
    console.error(`[AutoTC] 실행할 수 없습니다: ${e.message}`);
    return 2;
  }
  run.log.filter((l) => /^\[(사전 점검|안드로이드|완료)\]/.test(l)).forEach((l) => console.log(l));
  if (run.status !== 'done') {
    console.error(`[AutoTC] 실행 오류: ${run.error}`);
    console.error(run.log.slice(-30).join('\n'));
    return 2;
  }

  const issues = store.getIssues();
  const md = report.markdownSummary(run, issues);
  const junit = report.junitXml(run);
  const runDir = path.join(P.RUNS, run.id);
  fs.writeFileSync(path.join(runDir, 'summary.md'), md, 'utf8');
  fs.writeFileSync(path.join(runDir, 'junit.xml'), junit, 'utf8');
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'summary.md'), md, 'utf8');
    fs.writeFileSync(path.join(opts.out, 'junit.xml'), junit, 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
  if (process.env.AUTOTC_SLACK_WEBHOOK) await notifySlack(process.env.AUTOTC_SLACK_WEBHOOK, run);

  console.log(`\n${md}`);
  console.log(`[AutoTC] 리포트: ${path.relative(P.ROOT, runDir)}${path.sep}summary.md, junit.xml${run.htmlReport ? ', html-report' : ''}`);
  if (!run.summary.releasable && !opts.gate) console.log('[AutoTC] 종료 기준 미충족이지만 --no-gate로 성공 처리합니다');
  return run.summary.releasable || !opts.gate ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}

module.exports = { parseArgs };
