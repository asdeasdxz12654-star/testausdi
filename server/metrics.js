// 품질 지표: 실행 추세, TC별 판정 이력(히스토그램), 자동화 ROI, 커버리지, 테스트 분포.
// 근거: ISTQB CT-TAS 5.1(ROI = 절감 ÷ 투자, 시간 단위) · 5.2(지표), CTAL-TAE 8.1.1(테스트 히스토그램)
const { ACTIONS, API_ACTIONS } = require('./actions');

const ROI_DEFAULTS = {
  manualMinutesDefault: 5, // TC에 수동 실행 시간이 없을 때 쓰는 값 (분)
  setupHours: 16, // 도구·환경·프레임워크 구축 (시간)
  authorMinutesPerTc: 30, // 자동화 TC 하나를 만드는 데 드는 시간 (분)
  fixMinutesPerIssue: 30, // 스크립트 수정(AUT 이슈) 하나에 드는 시간 (분)
  analysisMinutesPerFailure: 10, // 실패·Flaky 결과 하나를 분석하는 시간 (분)
};

const EXECUTED = ['Pass', 'Fail', 'Flaky'];
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// API 액션만 쓰는 TC는 서비스(API) 계층, 화면을 조작하면 UI 계층
function layerOf(tc) {
  const actions = (tc.steps || []).map((s) => s.action).filter((a) => a !== 'flow');
  if (actions.length && actions.every((a) => API_ACTIONS.includes(a))) return 'api';
  return 'ui';
}

// 실행 기록·TC·이슈·이력으로 지표를 계산한다. runs는 완료된 실행 전체 기록(결과 포함), 오래된 것부터
function compute({ runs, tcs, issues, history, config }) {
  const roiConf = { ...ROI_DEFAULTS, ...(config.roi || {}) };
  const tcById = Object.fromEntries(tcs.map((t) => [t.id, t]));
  const done = runs.filter((r) => r.status === 'done' && r.summary);

  const trend = done.map((r) => ({
    id: r.id, label: r.label, startedAt: r.startedAt,
    durationMs: r.finishedAt ? new Date(r.finishedAt) - new Date(r.startedAt) : 0,
    passRate: r.summary.passRate, counts: r.summary.counts, releasable: r.summary.releasable,
  }));

  // TC × 실행 단위별 최근 판정 (issues.updateHistory가 20회까지 보관)
  const stability = Object.entries(history).map(([key, list]) => {
    const [tcId, project] = key.split('|');
    const n = (s) => list.filter((h) => h.status === s).length;
    return {
      tcId, project, title: tcById[tcId] ? tcById[tcId].title : '(삭제된 TC)',
      recent: list.map((h) => h.status), total: list.length, pass: n('Pass'), fail: n('Fail'), flaky: n('Flaky'),
    };
  }).map((s) => ({ ...s, unstable: s.total ? (s.fail + s.flaky) / s.total : 0 }))
    .sort((a, b) => b.unstable - a.unstable || b.flaky - a.flaky || a.tcId.localeCompare(b.tcId));

  // ROI: 절감 = Σ(수동 시간 − 자동 실행 시간), 투자 = 구축 + 작성 + 수정 + 실패 분석 (모두 분)
  let savedMin = 0;
  let executed = 0;
  let problems = 0;
  let failures = 0;
  const bugIds = new Set();
  let flaky = 0;
  for (const r of done) {
    for (const x of r.results) {
      if (!EXECUTED.includes(x.status)) continue;
      executed += 1;
      const tc = tcById[x.tcId];
      const manual = tc && Number.isFinite(tc.manualMinutes) ? tc.manualMinutes : roiConf.manualMinutesDefault;
      savedMin += manual - (x.durationMs || 0) / 60000;
      if (x.status !== 'Pass') problems += 1;
      if (x.status === 'Flaky') flaky += 1;
      if (x.status === 'Fail') {
        failures += 1;
        const issue = x.issueId && issues.find((i) => i.id === x.issueId);
        if (issue && issue.type === 'BUG') bugIds.add(issue.id);
      }
    }
  }
  const automated = tcs.filter((t) => t.automation !== '수동 유지');
  const autIssues = issues.filter((i) => i.type === 'AUT').length;
  const investment = {
    setup: roiConf.setupHours * 60,
    authoring: automated.length * roiConf.authorMinutesPerTc,
    maintenance: autIssues * roiConf.fixMinutesPerIssue,
    analysis: problems * roiConf.analysisMinutesPerFailure,
  };
  const investedMin = Object.values(investment).reduce((a, b) => a + b, 0);
  const perRun = done.length ? savedMin / done.length : 0;
  const roi = {
    config: roiConf,
    savedHours: round(savedMin / 60),
    investedHours: round(investedMin / 60),
    investment: Object.fromEntries(Object.entries(investment).map(([k, v]) => [k, round(v / 60)])),
    ratio: investedMin ? round(savedMin / investedMin, 2) : null,
    runs: done.length,
    executed,
    savedHoursPerRun: round(perRun / 60, 2),
    // 지금 속도로 몇 번 더 실행해야 투자를 회수하는지 (이미 회수했으면 0)
    runsToBreakEven: perRun > 0 ? Math.max(0, Math.ceil((investedMin - savedMin) / perRun)) : null,
    manualMissing: automated.filter((t) => !Number.isFinite(t.manualMinutes)).length,
  };

  // 커버리지: 자동화 비율, 요구사항(기능) 커버리지, 플랫폼별 TC 수
  const reqAll = new Set(tcs.flatMap((t) => t.reqIds || []));
  const reqAuto = new Set(automated.flatMap((t) => t.reqIds || []));
  const platforms = {};
  automated.forEach((t) => t.platforms.forEach((p) => { platforms[p] = (platforms[p] || 0) + 1; }));
  const coverage = {
    tcs: tcs.length,
    automated: automated.length,
    automatedRate: tcs.length ? automated.length / tcs.length : null,
    reqs: reqAll.size,
    reqsAutomated: reqAuto.size,
    reqRate: reqAll.size ? reqAuto.size / reqAll.size : null,
    reqsManualOnly: [...reqAll].filter((r) => !reqAuto.has(r)).sort(),
    withoutReq: automated.filter((t) => !(t.reqIds || []).length).map((t) => t.id),
    platforms,
  };

  const layers = { ui: 0, api: 0 };
  automated.forEach((t) => { layers[layerOf(t)] += 1; });
  const assertKinds = {};
  automated.forEach((t) => t.steps.forEach((s) => { if (ACTIONS[s.action] && ACTIONS[s.action].assert) assertKinds[s.action] = (assertKinds[s.action] || 0) + 1; }));
  // 테스트 분포 모양 (CT-TAS 3.1.1). 단위 테스트는 개발 저장소에 있어 여기서는 UI·API만 본다
  const shape = !automated.length ? null : layers.api === 0 ? 'umbrella' : layers.api < layers.ui ? 'cone' : 'pyramid';

  const recent = trend.slice(-5);
  return {
    trend, stability, roi, coverage,
    distribution: { layers, shape, assertKinds },
    quality: {
      failuresToDefects: bugIds.size ? round(failures / bugIds.size, 2) : null,
      failures, bugs: bugIds.size,
      flakyRate: executed ? flaky / executed : null,
      avgRunMs: recent.length ? Math.round(recent.reduce((a, r) => a + r.durationMs, 0) / recent.length) : null,
    },
  };
}

module.exports = { compute, layerOf, ROI_DEFAULTS };
