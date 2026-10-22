// TC 검증, 공통 흐름 펼치기, 테스트 데이터 치환, 플랫폼 지원 판정.
const { PLATFORMS, ACTIONS } = require('./actions');
const { HttpError } = require('./store');

const PRIORITIES = ['P1', 'P2', 'P3'];
const AUTOMATION = ['적합', '수동 유지'];

function validateTc(tc, { elements, flows }) {
  const errors = [];
  if (!tc || typeof tc !== 'object') throw new HttpError(400, 'TC 형식이 올바르지 않습니다');
  if (!/^[A-Za-z0-9_-]+$/.test(tc.id || '')) errors.push('ID는 영문, 숫자, -, _ 만 쓸 수 있습니다');
  if (!tc.title || !String(tc.title).trim()) errors.push('제목을 입력하세요');
  if (!PRIORITIES.includes(tc.priority)) errors.push(`우선순위는 ${PRIORITIES.join(', ')} 중 하나여야 합니다`);
  if (tc.automation && !AUTOMATION.includes(tc.automation)) errors.push(`자동화 적합도는 ${AUTOMATION.join(', ')} 중 하나여야 합니다`);
  if (!Array.isArray(tc.platforms) || tc.platforms.length === 0) errors.push('플랫폼을 하나 이상 고르세요');
  else tc.platforms.forEach((p) => { if (!PLATFORMS.includes(p)) errors.push(`알 수 없는 플랫폼: ${p}`); });
  // 수동 유지 TC는 스텝 없이 저장할 수 있다 (엑셀에서 가져온 뒤 나중에 채우는 경우)
  if (!Array.isArray(tc.steps) || (tc.steps.length === 0 && tc.automation !== '수동 유지')) errors.push('스텝을 하나 이상 추가하세요 (스텝 없이 두려면 자동화를 "수동 유지"로)');
  else {
    tc.steps.forEach((s, i) => {
      const no = i + 1;
      const def = ACTIONS[s.action];
      if (!def) { errors.push(`${no}번 스텝: 알 수 없는 액션 "${s.action}"`); return; }
      if (def.target === 'screen' && !elements.screens[s.target]) errors.push(`${no}번 스텝: 요소 맵에 없는 화면 "${s.target || ''}"`);
      if (def.target === 'element' && !elements.elements[s.target]) errors.push(`${no}번 스텝: 요소 맵에 없는 요소 "${s.target || ''}"`);
      if (def.target === 'flow' && !flows[s.target]) errors.push(`${no}번 스텝: 등록되지 않은 공통 흐름 "${s.target || ''}"`);
      if (def.value && (s.value === undefined || s.value === '')) errors.push(`${no}번 스텝: ${def.label} 액션은 값이 필요합니다`);
    });
  }
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const src = tc.source && typeof tc.source === 'object' ? tc.source : null;
  return {
    id: tc.id,
    title: String(tc.title).trim(),
    priority: tc.priority,
    automation: tc.automation || '적합',
    tags: (tc.tags || []).map((t) => String(t).trim()).filter(Boolean),
    reqIds: (tc.reqIds || []).map((t) => String(t).trim()).filter(Boolean),
    platforms: tc.platforms,
    precondition: tc.precondition || '',
    steps: tc.steps.map((s) => {
      const out = { action: s.action };
      if (ACTIONS[s.action].target) out.target = s.target;
      if (ACTIONS[s.action].value) out.value = String(s.value);
      return out;
    }),
    // 엑셀 원문 (가져온 TC만)
    ...(src ? {
      source: {
        file: String(src.file || ''), ...(src.url ? { url: String(src.url) } : {}), sheet: String(src.sheet || ''), row: Number(src.row) || null,
        originalId: src.originalId ? String(src.originalId) : null, steps: String(src.steps || ''), expected: String(src.expected || ''),
      },
    } : {}),
  };
}

// flow 스텝을 실제 스텝으로 펼친다. no는 펼친 뒤의 순번(리포트·재현 절차 기준)
function expandSteps(tc, flows) {
  const out = [];
  for (const s of tc.steps) {
    if (s.action === 'flow') {
      const flow = flows[s.target];
      if (!flow) throw new HttpError(400, `${tc.id}: 등록되지 않은 공통 흐름 ${s.target}`);
      flow.steps.forEach((fs) => out.push({ ...fs, fromFlow: s.target }));
    } else {
      out.push({ ...s });
    }
  }
  return out.map((s, i) => ({ ...s, no: i + 1 }));
}

function lookup(data, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), data);
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function resolveValue(raw, testData) {
  if (raw === undefined) return undefined;
  return String(raw).replace(TEMPLATE_RE, (_, key) => {
    const v = lookup(testData, key);
    if (v === undefined) throw new HttpError(400, `테스트 데이터에 ${key} 값이 없습니다 (data/testdata.json)`);
    return String(v);
  });
}

const isTemplate = (raw) => typeof raw === 'string' && /\{\{\s*[\w.]+\s*\}\}/.test(raw);

function supportOn(steps, platform) {
  const unsupported = [...new Set(steps.filter((s) => ACTIONS[s.action].support[platform] === 'unsupported').map((s) => s.action))];
  return { ok: unsupported.length === 0, unsupported };
}

// 리포트·결함 초안용 스텝 문장. 템플릿 값은 실제 값 대신 데이터 이름을 보여줘 계정 정보가 리포트에 남지 않게 한다.
function describeStep(step, elements) {
  const el = step.target && (elements.elements[step.target] || elements.screens[step.target]);
  const name = el ? el.label : step.target;
  const val = step.value === undefined ? '' : (isTemplate(step.value) ? `테스트 데이터 ${step.value.replace(/[{}\s]/g, '')}` : `"${step.value}"`);
  switch (step.action) {
    case 'open': return `${name} 화면 진입`;
    case 'input': return `${name}에 ${val} 입력`;
    case 'tap': return `${name} 탭`;
    case 'select': return `${name}에서 ${val} 선택`;
    case 'hover': return `${name}에 마우스 올리기`;
    case 'hideKeyboard': return '키보드 닫기';
    case 'back': return '뒤로 가기';
    case 'assertText': return `${name}에 ${val} 노출 확인`;
    case 'assertVisible': return `${name} 노출 확인`;
    case 'assertHidden': return `${name} 미노출 확인`;
    case 'assertUrl': return `주소에 ${val} 포함 확인`;
    default: return `${step.action} ${step.target || ''}`.trim();
  }
}

function stepTitle(step) {
  return `${step.no}. ${step.action}${step.target ? ` ${step.target}` : ''}${step.value !== undefined ? ` = ${step.value}` : ''}`;
}

module.exports = { PRIORITIES, AUTOMATION, validateTc, expandSteps, resolveValue, isTemplate, supportOn, describeStep, stepTitle };
