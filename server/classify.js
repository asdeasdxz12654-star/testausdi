// 실패 원인 1차 분류, 실패 시그니처, 결함 초안. 분류는 제안이고 확정은 QA가 한다.
const { PLATFORM_LABELS } = require('./actions');
const { describeStep } = require('./tc');

const CLASSIFICATIONS = {
  product: '제품 결함 의심',
  product_or_ui: '제품 결함 또는 UI 변경',
  script: '스크립트 수정 필요',
  env: '환경 문제',
  flaky: 'Flaky',
  unknown: '확인 필요',
};

const ISSUE_TYPE = { product: 'BUG', product_or_ui: 'BUG', unknown: 'BUG', script: 'AUT', env: 'ENV', flaky: 'FLK' };

function errorType(message) {
  if (!message) return 'UNKNOWN';
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ECONNRESET|page\.goto: Timeout/i.test(message)) return 'NETWORK';
  if (/Target (page|crashed)|browser has been closed|Page crashed/i.test(message)) return 'CRASH';
  if (/strict mode violation/i.test(message)) return 'MULTIPLE_MATCH';
  if (/element\(s\) not found/i.test(message)) return 'ELEMENT_NOT_FOUND';
  if (/Timeout \d+ms exceeded/i.test(message) && /waiting for (locator|getBy|page\.getBy)/i.test(message)) return 'ELEMENT_NOT_FOUND';
  if (/Expected[\s\S]*Received/i.test(message)) return 'ASSERTION_MISMATCH';
  if (/Timeout/i.test(message)) return 'TIMEOUT';
  return 'UNKNOWN';
}

// 실패한 시도에서 실패 스텝을 찾는다. 스텝 제목은 "3. tap login.submit = 값" 형식
function failedStep(attempt) {
  if (!attempt) return null;
  const step = attempt.steps.find((s) => s.error);
  if (!step) return null;
  const m = step.title.match(/^(\d+)\.\s+(\S+)(?:\s+([^\s=]+))?/);
  return { no: m ? Number(m[1]) : null, action: m ? m[2] : null, target: m ? m[3] || null : null, title: step.title, error: step.error };
}

// 같은 TC의 다른 플랫폼 결과와 비교해 분류한다. others: 같은 실행의 같은 TC, 다른 플랫폼 결과들
function classify(result, others) {
  if (result.status === 'Flaky') return 'flaky';
  if (result.status !== 'Fail') return null;
  const type = result.errorType;
  if (['NETWORK', 'TIMEOUT', 'DEVICE', 'APP_LAUNCH'].includes(type)) return 'env';
  if (type === 'CRASH') return 'product';
  if (type === 'ASSERTION_MISMATCH') return 'product';
  if (type === 'MULTIPLE_MATCH') return 'script';
  if (type === 'ELEMENT_NOT_FOUND') {
    const executed = others.filter((o) => o.status === 'Pass' || o.status === 'Flaky' || o.status === 'Fail');
    if (!executed.length) return 'product_or_ui';
    const sameStepPassedElsewhere = executed.some((o) => o.status !== 'Fail' || (o.failedStep && result.failedStep && o.failedStep.no > result.failedStep.no));
    return sameStepPassedElsewhere ? 'script' : 'product_or_ui';
  }
  return 'unknown';
}

function signature(result) {
  const fs = result.failedStep || {};
  return [result.platform, result.tcId, fs.no || 0, result.errorType || 'UNKNOWN', fs.target || ''].join('|');
}

function firstLine(text) {
  return (text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

function actualText(result) {
  const err = (result.failedStep && result.failedStep.error) || result.error || '';
  const received = err.match(/Received(?: string)?:\s*(.+)/);
  if (received) return `${received[1].trim()} (기대: ${(err.match(/Expected(?: string| pattern)?:\s*(.+)/) || [])[1] || '-'})`;
  if (result.errorType === 'ELEMENT_NOT_FOUND') return '대상 요소가 화면에 나타나지 않음 (대기 시간 초과)';
  return firstLine(err);
}

function defectDraft(result, ctx) {
  const { tc, steps, elements, deviceLabel, baseURL, others } = ctx;
  const fsNo = result.failedStep && result.failedStep.no;
  const repro = steps
    .filter((s) => !fsNo || s.no <= fsNo)
    .map((s, i) => `  ${i + 1}. ${describeStep(s, elements)}`);
  const lastAssert = [...steps].reverse().find((s) => s.action.startsWith('assert'));
  const failed = fsNo ? steps.find((s) => s.no === fsNo) : null;
  // 실패 스텝이 확인 스텝이면 그 문장이 기대결과, 조작 스텝이면 "조작할 수 있음" + TC의 최종 기대결과
  let expected = '-';
  if (failed && failed.action.startsWith('assert')) expected = describeStep(failed, elements);
  else if (failed) {
    const el = elements.elements[failed.target];
    expected = `${el ? el.label : failed.target}이(가) 노출되어 진행 가능${lastAssert ? ` (최종 기대: ${describeStep(lastAssert, elements)})` : ''}`;
  } else if (lastAssert) expected = describeStep(lastAssert, elements);
  const failedAttempts = result.attempts.filter((a) => a.status !== 'passed').length;
  const passedElsewhere = others.filter((o) => o.status === 'Pass').map((o) => PLATFORM_LABELS[o.platform]);
  const files = result.attachments.map((a) => a.url.split('/').pop());
  return [
    `[${PLATFORM_LABELS[result.platform]}] ${tc.title} 실패`,
    `환경: ${deviceLabel} · ${baseURL}`,
    `TC: ${tc.id} (${tc.priority})${tc.reqIds.length ? ` · 요구사항 ${tc.reqIds.join(', ')}` : ''}`,
    `사전조건: ${tc.precondition || '-'}`,
    '재현 절차:',
    ...repro,
    `기대결과: ${expected}`,
    `실제결과: ${actualText(result)}`,
    `재현율: ${failedAttempts}/${result.attempts.length} (자동 재시도 포함)`,
    `첨부: ${files.length ? files.join(', ') : '-'}`,
    passedElsewhere.length ? `참고: 같은 TC가 ${passedElsewhere.join(' · ')}에서는 Pass` : null,
  ].filter((l) => l !== null).join('\n');
}

module.exports = { CLASSIFICATIONS, ISSUE_TYPE, errorType, failedStep, classify, signature, defectDraft, actualText };
