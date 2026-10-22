// CI용 리포트: 사람이 읽는 Markdown 요약과 CI 도구가 읽는 JUnit XML.
const { PLATFORM_LABELS } = require('./actions');
const { CLASSIFICATIONS } = require('./classify');

const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`);
const cell = (s) => String(s === null || s === undefined ? '-' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const firstLine = (s) => (s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

function markdownSummary(run, issues) {
  const sm = run.summary;
  const c = sm.counts;
  const dur = run.finishedAt ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000) : 0;
  const lines = [
    `## AutoTC ${run.label} · ${sm.releasable ? '✅ 종료 기준 충족' : '❌ 종료 기준 미충족'}`,
    '',
    `실행 ${run.id} · TC ${run.tcIds.length}건 · ${run.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')} · ${dur}초`,
    '',
    '| Pass | Fail | Flaky | Blocked | Skipped | 통과율 |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${c.Pass} | ${c.Fail} | ${c.Flaky} | ${c.Blocked} | ${c.Skipped} | ${pct(sm.passRate)} |`,
    '',
    '### 종료 기준',
    '',
    ...sm.exit.map((e) => `- ${e.ok ? '✅' : '❌'} ${e.label}: ${e.percent ? pct(e.value) : e.value} (기준 ${e.percent ? pct(e.max) : `${e.max} 이하`})`),
    '',
    '### 플랫폼별',
    '',
    '| 플랫폼 | Pass | Fail | Flaky | Blocked | Skipped |',
    '|---|---:|---:|---:|---:|---:|',
    ...run.platforms.map((p) => { const b = sm.byPlatform[p]; return `| ${PLATFORM_LABELS[p]} | ${b.Pass} | ${b.Fail} | ${b.Flaky} | ${b.Blocked} | ${b.Skipped} |`; }),
  ];
  const problems = run.results.filter((r) => ['Fail', 'Flaky', 'Blocked'].includes(r.status));
  if (problems.length) {
    const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
    lines.push('', '### 확인이 필요한 결과', '', '| TC | 플랫폼 | 상태 | 실패 스텝 / 사유 | 분류 제안 | 이슈 |', '|---|---|---|---|---|---|');
    for (const r of problems) {
      const cls = r.classification.confirmed || r.classification.proposed;
      const issue = r.issueId ? `${r.issueId}${r.knownIssue ? ' (기존)' : ' (신규)'}${byId[r.issueId] && byId[r.issueId].severity ? ` ${byId[r.issueId].severity}` : ''}` : '-';
      lines.push(`| ${cell(`${r.tcId} ${r.title}`)} | ${cell(r.device)} | ${r.status}${r.quarantined ? ' (격리)' : ''} | ${cell(r.failedStep ? r.failedStep.title : r.reason)} | ${cell(cls ? CLASSIFICATIONS[cls] : '-')} | ${cell(issue)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

const xml = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function junitXml(run) {
  const groups = new Map();
  for (const r of run.results) {
    if (!groups.has(r.project)) groups.set(r.project, []);
    groups.get(r.project).push(r);
  }
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = run.results.length;
  const failures = run.results.filter((r) => r.status === 'Fail').length;
  const skipped = run.results.filter((r) => r.status === 'Blocked' || r.status === 'Skipped').length;
  out.push(`<testsuites name="AutoTC ${xml(run.label)}" tests="${total}" failures="${failures}" skipped="${skipped}">`);
  for (const [project, results] of groups) {
    const f = results.filter((r) => r.status === 'Fail').length;
    const s = results.filter((r) => r.status === 'Blocked' || r.status === 'Skipped').length;
    const time = results.reduce((a, r) => a + (r.durationMs || 0), 0) / 1000;
    out.push(`  <testsuite name="${xml(project)}" tests="${results.length}" failures="${f}" skipped="${s}" time="${time.toFixed(3)}">`);
    for (const r of results) {
      out.push(`    <testcase classname="${xml(project === r.platform ? r.platform : `${r.platform}.${project}`)}" name="${xml(`${r.tcId} ${r.title}`)}" time="${((r.durationMs || 0) / 1000).toFixed(3)}">`);
      if (r.status === 'Fail') {
        const cls = r.classification.confirmed || r.classification.proposed;
        out.push(`      <failure message="${xml(`${r.failedStep ? `${r.failedStep.title}: ` : ''}${firstLine(r.error)}`)}" type="${xml(r.errorType)}">${xml(`${cls ? `분류 제안: ${CLASSIFICATIONS[cls]}\n` : ''}${r.issueId ? `이슈: ${r.issueId}\n` : ''}${r.error || ''}`)}</failure>`);
      } else if (r.status === 'Blocked' || r.status === 'Skipped') {
        out.push(`      <skipped message="${xml(`${r.status}: ${r.reason || ''}`)}"/>`);
      } else if (r.status === 'Flaky') {
        out.push(`      <system-out>${xml(`Flaky: 재시도 후 통과. 첫 실패: ${firstLine(r.error)}`)}</system-out>`);
      }
      out.push('    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return out.join('\n') + '\n';
}

module.exports = { markdownSummary, junitXml };
