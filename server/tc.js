// TC 검증, 공통 흐름 펼치기, 테스트 데이터 치환, 플랫폼 지원 판정.
const { PLATFORMS, ACTIONS } = require('./actions');
const { HttpError } = require('./store');
const { isSecretRef } = require('./secrets');

const PRIORITIES = ['P1', 'P2', 'P3'];
const AUTOMATION = ['적합', '수동 유지'];

const API_REQ_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\S+$/i;
const STATUS_RE = /^(\d{3}|\dxx)$/i;
const ROW_RE = /\{\{\s*row\.(\w+)\s*\}\}/g;
const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

// 데이터 행: 같은 스텝을 행마다 한 번씩 실행한다 (데이터 주도). 값은 {{row.키}}로 쓴다
function validateDataSets(tc, errors) {
  const sets = tc.dataSets;
  const used = [...new Set(tc.steps.flatMap((s) => [...String(s.value || '').matchAll(ROW_RE), ...String(s.body || '').matchAll(ROW_RE)].map((m) => m[1])))];
  if (sets === undefined || sets === null || (Array.isArray(sets) && !sets.length)) {
    if (used.length) errors.push(`스텝에 {{row.${used[0]}}}가 있지만 데이터 행이 없습니다`);
    return;
  }
  if (!Array.isArray(sets) || sets.length > 100) { errors.push('데이터 행은 100개까지 넣을 수 있습니다'); return; }
  const names = new Set();
  sets.forEach((r, i) => {
    const name = r && String(r.name || '').trim();
    if (!name || name.length > 40) errors.push(`데이터 ${i + 1}행: 이름을 40자 이내로 입력하세요`);
    else if (names.has(name)) errors.push(`데이터 행 이름이 겹칩니다: ${name}`);
    names.add(name);
    const values = (r && r.values) || {};
    used.forEach((k) => { if (values[k] === undefined) errors.push(`데이터 행 ${name || i + 1}: ${k} 값이 없습니다`); });
  });
}

function validateTc(tc, { elements, flows, schemas = {} }) {
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
      if (def.target === 'element' && !(def.targetOptional && !s.target) && !elements.elements[s.target]) errors.push(`${no}번 스텝: 요소 맵에 없는 요소 "${s.target || ''}"`);
      if (def.target === 'flow' && !flows[s.target]) errors.push(`${no}번 스텝: 등록되지 않은 공통 흐름 "${s.target || ''}"`);
      if (def.target === 'path' && !/^\S+$/.test(s.target || '')) errors.push(`${no}번 스텝: 응답 JSON 경로를 입력하세요 (예: data.items[0].id)`);
      if (def.target === 'schema' && !schemas[s.target]) errors.push(`${no}번 스텝: data/schemas에 없는 명세 "${s.target || ''}"`);
      const empty = s.value === undefined || s.value === '';
      if (def.value && empty && !def.valueOptional) errors.push(`${no}번 스텝: ${def.label} 액션은 값이 필요합니다`);
      if (def.body && s.body) {
        try { JSON.parse(String(s.body).replace(TEMPLATE_RE, '0')); } catch { errors.push(`${no}번 스텝: 요청 본문이 JSON 형식이 아닙니다`); }
      }
      if (empty) return;
      const v = String(s.value);
      if (def.options && !def.options.includes(v)) errors.push(`${no}번 스텝: ${def.label} 값은 ${def.options.join(', ')} 중 하나여야 합니다`);
      if (s.action === 'apiRequest' && !API_REQ_RE.test(v)) errors.push(`${no}번 스텝: API 요청은 "GET /경로"처럼 방식과 주소를 쓰세요`);
      if (s.action === 'assertStatus' && !STATUS_RE.test(v)) errors.push(`${no}번 스텝: 응답 코드는 200 또는 2xx 형식입니다`);
      if (s.action === 'saveValue' && !/^\w+$/.test(v)) errors.push(`${no}번 스텝: 저장 이름은 영문·숫자·_ 만 씁니다`);
      if (s.action === 'assertScreenshot' && !/^[\w가-힣-]+$/.test(v)) errors.push(`${no}번 스텝: 기준 이미지 이름은 한글·영문·숫자·-·_ 만 씁니다`);
    });
    validateDataSets(tc, errors);
  }
  const mm = tc.manualMinutes;
  const hasMm = mm !== undefined && mm !== null && mm !== '';
  if (hasMm && !(Number(mm) >= 0 && Number(mm) <= 1440)) errors.push('수동 실행 시간은 0~1440분입니다');
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
      const def = ACTIONS[s.action];
      const out = { action: s.action };
      if (def.target && (s.target || !def.targetOptional)) out.target = s.target;
      if (def.value && ((s.value !== undefined && s.value !== '') || !def.valueOptional)) out.value = String(s.value);
      if (def.body && s.body) out.body = String(s.body);
      return out;
    }),
    // 데이터 행 (데이터 주도 TC만)
    ...(Array.isArray(tc.dataSets) && tc.dataSets.length ? {
      dataSets: tc.dataSets.map((r) => ({ name: String(r.name).trim(), values: Object.fromEntries(Object.entries(r.values || {}).map(([k, v]) => [k, String(v)])) })),
    } : {}),
    // 같은 TC를 사람이 수동으로 실행할 때 걸리는 시간 (ROI 계산용, 분)
    ...(hasMm ? { manualMinutes: Number(mm) } : {}),
    // 영역 매핑에서 승인·반영된 화면·요소 (매핑한 TC만)
    ...(tc.mapping && typeof tc.mapping === 'object' ? {
      mapping: {
        project: String(tc.mapping.project || ''), frame: String(tc.mapping.frame || ''), approvedAt: String(tc.mapping.approvedAt || ''),
        elements: Array.isArray(tc.mapping.elements) ? tc.mapping.elements.map(String) : [],
      },
    } : {}),
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

// 값 문자열을 조각으로 나눈다: { lit: 글자, filled: 템플릿에서 채운 값인지 } | { secret: 비밀값 이름 } | { saved: 앞 스텝에서 저장한 이름 }
// row: 데이터 행 ({ name, values }). {{row.키}}는 행 값, {{saved.이름}}은 실행 중 값, 나머지는 테스트 데이터
function valueParts(raw, testData, row) {
  const text = String(raw);
  const parts = [];
  let last = 0;
  text.replace(TEMPLATE_RE, (m, key, offset) => {
    if (offset > last) parts.push({ lit: text.slice(last, offset) });
    last = offset + m.length;
    if (key.startsWith('saved.')) { parts.push({ saved: key.slice(6) }); return m; }
    if (key.startsWith('row.')) {
      const k = key.slice(4);
      if (!row) throw new HttpError(400, `{{${key}}}는 데이터 행이 있는 TC에서만 쓸 수 있습니다`);
      if (row.values[k] === undefined) throw new HttpError(400, `데이터 행 ${row.name}에 ${k} 값이 없습니다`);
      parts.push({ lit: String(row.values[k]), filled: true });
      return m;
    }
    const v = lookup(testData, key);
    if (v === undefined) throw new HttpError(400, `테스트 데이터에 ${key} 값이 없습니다 (data/testdata.json)`);
    if (isSecretRef(v)) parts.push({ secret: v.secret });
    else if (v && typeof v === 'object') throw new HttpError(400, `테스트 데이터 ${key}는 값이 아니라 묶음입니다`);
    else parts.push({ lit: String(v), filled: true });
    return m;
  });
  if (last < text.length) parts.push({ lit: text.slice(last) });
  return parts;
}

// 값을 글자로 바로 바꾼다. 비밀값은 opts.secret(이름)이 주는 글자로 (없으면 오류), 실행 중 값은 쓸 수 없다
function resolveValue(raw, testData, opts = {}) {
  if (raw === undefined) return undefined;
  return valueParts(raw, testData, opts.row).map((p) => {
    if (p.lit !== undefined) return p.lit;
    if (p.secret) {
      if (!opts.secret) throw new HttpError(400, `비밀값 ${p.secret}은(는) 이 액션에 쓸 수 없습니다`);
      return opts.secret(p.secret);
    }
    throw new HttpError(400, `{{saved.${p.saved}}}는 웹·API 실행에서만 쓸 수 있습니다`);
  }).join('');
}

const rowsOf = (tc) => (tc.dataSets && tc.dataSets.length ? tc.dataSets : [null]);

// TC가 쓰는 비밀값 이름 (공통 흐름 포함)
function secretsUsed(tc, flows, testData) {
  const names = new Set();
  for (const s of expandSteps(tc, flows)) {
    for (const raw of [s.value, s.body]) {
      if (raw === undefined) continue;
      for (const row of rowsOf(tc)) valueParts(raw, testData, row).forEach((p) => { if (p.secret) names.add(p.secret); });
    }
  }
  return [...names];
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
    case 'assertScreenshot': return `${step.target ? name : '화면 전체'}를 기준 이미지 ${val}와 비교`;
    case 'assertA11y': return `화면 접근성 검사 (${step.value || 'serious'} 이상 위반 없음)`;
    case 'apiRequest': return `API ${step.value} 요청`;
    case 'assertStatus': return `응답 코드 ${step.value} 확인`;
    case 'assertJson': return `응답 ${step.target} 값이 ${val}인지 확인`;
    case 'assertSchema': return `응답이 ${step.target} 명세와 맞는지 확인`;
    case 'saveValue': return `응답 ${step.target} 값을 ${step.value}(으)로 저장`;
    default: return `${step.action} ${step.target || ''}`.trim();
  }
}

function stepTitle(step) {
  return `${step.no}. ${step.action}${step.target ? ` ${step.target}` : ''}${step.value !== undefined ? ` = ${step.value}` : ''}`;
}

module.exports = { PRIORITIES, AUTOMATION, TEMPLATE_RE, validateTc, expandSteps, valueParts, resolveValue, secretsUsed, rowsOf, isTemplate, supportOn, describeStep, stepTitle };
