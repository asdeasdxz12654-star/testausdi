// 이슈 관리: 실패 시그니처로 중복을 묶고, 재검증 결과로 상태를 바꾸고, Flaky 이력으로 격리 여부를 정한다.
const { ISSUE_TYPE, CLASSIFICATIONS } = require('./classify');
const { PLATFORM_LABELS } = require('./actions');

const BUG_STATUSES = ['신규', '확인', '수정중', '수정 완료', '보류', '재오픈', '종료'];
const OTHER_STATUSES = ['신규', '조치중', '종료'];
const SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'];

const statusesFor = (type) => (type === 'BUG' ? BUG_STATUSES : OTHER_STATUSES);

function nextId(issues) {
  const max = issues.reduce((m, i) => Math.max(m, Number(i.id.replace(/\D/g, '')) || 0), 0);
  return `ISS-${String(max + 1).padStart(4, '0')}`;
}

function defaultSeverity(result, tc) {
  if (result.errorType === 'CRASH') return 'Critical';
  return { P1: 'Major', P2: 'Minor', P3: 'Trivial' }[tc.priority] || 'Minor';
}

function issueTitle(result, tc) {
  const step = result.failedStep ? `${result.failedStep.no}번 스텝` : '실행';
  return `${tc.title} · ${step} 실패`;
}

// 실행 결과를 이슈 목록에 반영한다. issues는 제자리에서 수정하고, 결과마다 issueId·knownIssue를 채운다.
function applyRun(run, tcsById, issues, now = new Date().toISOString()) {
  for (const r of run.results) {
    const tc = tcsById[r.tcId];
    if (r.status === 'Pass') {
      // 수정 완료 상태였던 결함이 통과하면 재검증 통과로 종료
      issues
        .filter((i) => i.tcId === r.tcId && i.platform === r.platform && i.status === '수정 완료')
        .forEach((i) => {
          i.status = '종료';
          i.history.push({ at: now, runId: run.id, event: '재검증 Pass로 종료' });
          r.retestedIssues = [...(r.retestedIssues || []), i.id];
        });
      continue;
    }
    if (r.status !== 'Fail' && r.status !== 'Flaky') continue;
    const cls = r.classification.confirmed || r.classification.proposed;
    const existing = issues.find((i) => i.signature === r.signature);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.lastRunId = run.id;
      r.issueId = existing.id;
      if (existing.status === '종료' || existing.status === '수정 완료') {
        const from = existing.status;
        existing.status = existing.type === 'BUG' ? '재오픈' : '신규';
        existing.history.push({ at: now, runId: run.id, event: `${from} 상태에서 다시 발생해 ${existing.status}` });
        r.knownIssue = false;
      } else {
        r.knownIssue = true;
      }
      continue;
    }
    const type = ISSUE_TYPE[cls] || 'BUG';
    const issue = {
      id: nextId(issues),
      type,
      classification: cls,
      severity: type === 'BUG' ? defaultSeverity(r, tc) : null,
      title: issueTitle(r, tc),
      tcId: r.tcId,
      platform: r.platform,
      device: r.device,
      stepNo: r.failedStep ? r.failedStep.no : null,
      stepTitle: r.failedStep ? r.failedStep.title : null,
      errorType: r.errorType,
      signature: r.signature,
      status: '신규',
      count: 1,
      firstSeen: now,
      lastSeen: now,
      firstRunId: run.id,
      lastRunId: run.id,
      resultKey: r.key,
      trackerId: '',
      note: '',
      draft: r.defectDraft,
      history: [{ at: now, runId: run.id, event: `${PLATFORM_LABELS[r.platform]} 실행에서 생성 (${CLASSIFICATIONS[cls] || cls})` }],
    };
    issues.push(issue);
    r.issueId = issue.id;
    r.knownIssue = false;
  }
  return issues;
}

function updateIssue(issue, patch, now = new Date().toISOString()) {
  const changes = [];
  if (patch.type && patch.type !== issue.type) {
    if (!['BUG', 'AUT', 'ENV', 'FLK'].includes(patch.type)) throw new Error(`알 수 없는 이슈 유형: ${patch.type}`);
    changes.push(`유형 ${issue.type} → ${patch.type}`);
    issue.type = patch.type;
    if (!statusesFor(issue.type).includes(issue.status)) issue.status = '신규';
    if (issue.type !== 'BUG') issue.severity = null;
    else if (!issue.severity) issue.severity = 'Minor';
  }
  if (patch.status && patch.status !== issue.status) {
    if (!statusesFor(issue.type).includes(patch.status)) throw new Error(`${issue.type} 이슈에 쓸 수 없는 상태: ${patch.status}`);
    changes.push(`상태 ${issue.status} → ${patch.status}`);
    issue.status = patch.status;
  }
  if (patch.severity !== undefined && patch.severity !== issue.severity) {
    if (issue.type !== 'BUG') throw new Error('심각도는 제품 결함(BUG)에만 지정합니다');
    if (!SEVERITIES.includes(patch.severity)) throw new Error(`알 수 없는 심각도: ${patch.severity}`);
    changes.push(`심각도 ${issue.severity} → ${patch.severity}`);
    issue.severity = patch.severity;
  }
  if (patch.trackerId !== undefined && patch.trackerId !== issue.trackerId) {
    changes.push(`이슈 트래커 ${patch.trackerId || '연결 해제'}`);
    issue.trackerId = String(patch.trackerId).trim();
  }
  if (patch.note !== undefined && patch.note !== issue.note) {
    changes.push('메모 수정');
    issue.note = String(patch.note);
  }
  if (changes.length) issue.history.push({ at: now, event: changes.join(', ') });
  return issue;
}

// TC×프로젝트별 최근 판정 이력. 격리 여부(isQuarantined)의 근거가 된다
function updateHistory(history, run) {
  for (const r of run.results) {
    if (!['Pass', 'Fail', 'Flaky'].includes(r.status)) continue;
    const key = `${r.tcId}|${r.project}`;
    history[key] = [...(history[key] || []), { runId: run.id, status: r.status }].slice(-20);
  }
  return history;
}

// 최근 window회 중 Flaky가 flakyThreshold회 이상이면 격리
function isQuarantined(history, key, quarantine) {
  const recent = (history[key] || []).slice(-quarantine.window);
  return recent.filter((h) => h.status === 'Flaky').length >= quarantine.flakyThreshold;
}

module.exports = { BUG_STATUSES, OTHER_STATUSES, SEVERITIES, statusesFor, applyRun, updateIssue, updateHistory, isQuarantined };
