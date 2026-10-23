// 테스트 설계 규칙 (AI 없음). ISTQB CTFL 4.0의 동등 분할(EP)·경계값 분석(BVA, 2값)으로
// 입력 조건표에서 테스트 조건과 데이터 행을 만들고, 텍스트 기획서에서 조건 문장·모호한 문장을 찾는다.

const TECHNIQUES = { EP: '동등 분할', BVA: '경계값', DT: '결정표', ST: '상태 전이', EG: '오류 추정', UC: '유스케이스' };
const TYPES = { positive: '정상', negative: '예외', boundary: '경계', permission: '권한', exception: '오류 처리' };
const POLICY_RE = /\b[A-Z]{2,6}-\d{1,4}\b/g;
const normText = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

// 받침에 맞는 조사: josa('이름', '을', '를') → 이름을, josa('비밀번호', '을', '를') → 비밀번호를
function josa(word, withFinal, without) {
  const ch = String(word).trim().slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  const has = code >= 0 && code <= 11171 ? code % 28 !== 0 : /[0136-8lmnLMN]$/.test(ch);
  return `${word}${has ? withFinal : without}`;
}

// ---- 입력 조건표 ----
// 머리글 이름 → 칸. 엑셀에서 복사한 표(탭)나 CSV(쉼표)를 받는다
const FORM_COLS = {
  label: /^(필드|항목|이름|입력\s*항목)$/,
  element: /^(요소|요소\s*키|요소\s*이름)$/,
  type: /^(유형|타입|형식)$/,
  required: /^필수$/,
  min: /^(최소|최소\s*길이|최솟값)$/,
  max: /^(최대|최대\s*길이|최댓값)$/,
  options: /^(허용값|선택값|선택지)$/,
  requiredError: /^필수\s*오류(\s*문구)?$/,
  ruleError: /^(규칙|형식|길이)\s*오류(\s*문구)?$|^오류\s*문구$/,
  example: /^(유효\s*예시|예시|유효값)$/,
};
const TYPE_OF = [
  [/^(문자|텍스트|글자|text)$/i, 'text'], [/^(숫자|number|정수)$/i, 'number'], [/^(이메일|email|메일)$/i, 'email'],
  [/^(전화|휴대폰|phone|전화번호)$/i, 'phone'], [/^(선택|select|목록)$/i, 'select'],
];
const YES = /^(y|yes|예|o|필수|true|1)$/i;
const FORM_HEADER = '필드\t요소\t유형\t필수\t최소\t최대\t허용값\t필수 오류\t규칙 오류\t유효 예시';

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  // 큰따옴표로 감싼 칸 안의 쉼표는 나누지 않는다
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const intOrNull = (v) => (v === '' || v === undefined ? null : /^-?\d+$/.test(String(v).trim()) ? Number(v) : NaN);

// 행 값 키: 요소 이름 마지막 조각 (checkout.firstName → firstName). error는 오류 문구 칸이 쓴다
function rowKey(element, used) {
  let k = String(element).split('.').pop().replace(/\W/g, '_') || 'field';
  if (/^\d/.test(k)) k = `f_${k}`;
  if (k === 'error') k = 'error_value';
  let out = k;
  for (let i = 2; used.has(out); i += 1) out = `${k}${i}`;
  used.add(out);
  return out;
}

function parseForm(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { fields: [], errors: [] };
  const head = splitRow(lines[0]);
  const col = {};
  head.forEach((hd, i) => { for (const [k, re] of Object.entries(FORM_COLS)) if (re.test(hd) && col[k] === undefined) col[k] = i; });
  const errors = [];
  if (col.label === undefined || col.element === undefined) return { fields: [], errors: ['조건표 첫 줄에 "필드"와 "요소" 머리글이 있어야 합니다'] };
  const used = new Set();
  const fields = lines.slice(1).map((line, i) => {
    const c = splitRow(line);
    const get = (k) => (col[k] === undefined ? '' : (c[col[k]] || '').trim());
    const no = i + 2;
    const rawType = get('type') || '문자';
    const type = (TYPE_OF.find(([re]) => re.test(rawType)) || [])[1];
    if (!type) errors.push(`${no}행: 알 수 없는 유형 "${rawType}" (문자, 숫자, 이메일, 전화, 선택)`);
    const min = intOrNull(get('min'));
    const max = intOrNull(get('max'));
    if (Number.isNaN(min) || Number.isNaN(max)) errors.push(`${no}행: 최소·최대는 정수로 씁니다`);
    if (Number.isInteger(min) && Number.isInteger(max) && min > max) errors.push(`${no}행: 최소가 최대보다 큽니다`);
    if (type !== 'number' && ((Number.isInteger(min) && min < 0) || (Number.isInteger(max) && max < 1))) errors.push(`${no}행: 길이는 0 이상이어야 합니다`);
    const options = get('options').split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (type === 'select' && !options.length) errors.push(`${no}행: 선택 유형은 허용값을 "|"로 나눠 적습니다`);
    if (!get('label') || !get('element')) errors.push(`${no}행: 필드와 요소를 채워 주세요`);
    return {
      no, label: get('label'), element: get('element'), key: rowKey(get('element'), used), type: type || 'text',
      required: YES.test(get('required')), min: Number.isInteger(min) ? min : null, max: Number.isInteger(max) ? max : null,
      options, requiredError: get('requiredError'), ruleError: get('ruleError'), example: get('example'),
    };
  });
  return { fields, errors };
}

// ---- 값 만들기 ----
const SEED = 'autotcqa';
const textOf = (n) => SEED.repeat(Math.ceil(Math.max(0, n) / SEED.length)).slice(0, Math.max(0, n));
function emailOf(n) {
  // 전체 길이가 n인 이메일 (a...@qa.com). 8자보다 짧으면 이메일 모양을 만들 수 없다
  return n >= 8 ? `${textOf(n - 7)}@qa.com` : textOf(n);
}
const phoneOf = (n) => '01012345678'.padEnd(Math.max(0, n), '0').slice(0, Math.max(0, n));

function sized(f, n) {
  if (f.type === 'email') return emailOf(n);
  if (f.type === 'phone') return phoneOf(n);
  return textOf(n);
}

function validValue(f) {
  if (f.example) return f.example;
  if (f.type === 'select') return f.options[0];
  if (f.type === 'number') {
    if (f.min !== null && f.max !== null) return String(Math.floor((f.min + f.max) / 2));
    return String(f.min !== null ? f.min : f.max !== null ? f.max : 1);
  }
  const base = { text: 8, email: 14, phone: 11 }[f.type];
  const lo = f.min !== null ? f.min : 1;
  const hi = f.max !== null ? f.max : Math.max(base, lo);
  return sized(f, Math.min(Math.max(base, lo), hi));
}

// ---- 조건 ----
// 조건: { key, field, text, technique, type, valid, value, expected, label }
// label은 데이터 행 이름(40자 이내)으로 쓴다
function formConditions(form, fields) {
  const name = form.name || '입력 폼';
  const out = [{ key: 'valid:all', field: null, text: `${name}: 모든 필드에 유효한 값을 넣고 제출하면 다음 단계로 진행`, technique: 'EP', type: 'positive', valid: true, value: null, expected: '', label: '전체 유효값' }];
  const add = (f, kind, c) => out.push({ key: `${f.key}:${kind}`, field: f.key, ...c, label: c.label.slice(0, 40) });
  for (const f of fields) {
    const L = f.label;
    if (f.required) add(f, 'required', { text: `${josa(L, '을', '를')} 비우고 제출하면 필수 오류`, technique: 'EP', type: 'negative', valid: false, value: '', expected: f.requiredError, label: `${L} 빈 값` });
    if (f.type === 'number') {
      if (f.min !== null) {
        add(f, 'min-1', { text: `${L}에 최솟값보다 1 작은 ${f.min - 1} 입력 시 오류`, technique: 'BVA', type: 'boundary', valid: false, value: String(f.min - 1), expected: f.ruleError, label: `${L} ${f.min - 1}(최소-1)` });
        add(f, 'min', { text: `${L}에 최솟값 ${f.min} 입력 시 통과`, technique: 'BVA', type: 'boundary', valid: true, value: String(f.min), expected: '', label: `${L} ${f.min}(최소)` });
      }
      if (f.max !== null) {
        add(f, 'max', { text: `${L}에 최댓값 ${f.max} 입력 시 통과`, technique: 'BVA', type: 'boundary', valid: true, value: String(f.max), expected: '', label: `${L} ${f.max}(최대)` });
        add(f, 'max+1', { text: `${L}에 최댓값보다 1 큰 ${f.max + 1} 입력 시 오류`, technique: 'BVA', type: 'boundary', valid: false, value: String(f.max + 1), expected: f.ruleError, label: `${L} ${f.max + 1}(최대+1)` });
      }
      add(f, 'nan', { text: `${L}에 숫자가 아닌 값 입력 시 오류`, technique: 'EP', type: 'negative', valid: false, value: 'abc', expected: f.ruleError, label: `${L} 숫자 아님` });
    } else if (f.type === 'select') {
      f.options.forEach((o, i) => add(f, `opt${i + 1}`, { text: `${L}에서 "${o}" 선택 시 통과`, technique: 'EP', type: 'positive', valid: true, value: o, expected: '', label: `${L} ${o}` }));
    } else {
      // 최소 길이가 1이고 필수면 "최소-1"(빈 값)은 필수 조건과 같아 만들지 않는다
      if (f.min !== null && f.min > 0 && !(f.min === 1 && f.required)) {
        add(f, 'min-1', { text: `${josa(L, '을', '를')} ${f.min - 1}자(최소-1)로 입력 시 오류`, technique: 'BVA', type: 'boundary', valid: false, value: sized(f, f.min - 1), expected: f.ruleError, label: `${L} ${f.min - 1}자(최소-1)` });
      }
      if (f.min !== null && f.min > 0) add(f, 'min', { text: `${josa(L, '을', '를')} ${f.min}자(최소)로 입력 시 통과`, technique: 'BVA', type: 'boundary', valid: true, value: sized(f, f.min), expected: '', label: `${L} ${f.min}자(최소)` });
      if (f.max !== null) {
        add(f, 'max', { text: `${josa(L, '을', '를')} ${f.max}자(최대)로 입력 시 통과`, technique: 'BVA', type: 'boundary', valid: true, value: sized(f, f.max), expected: '', label: `${L} ${f.max}자(최대)` });
        add(f, 'max+1', { text: `${josa(L, '을', '를')} ${f.max + 1}자(최대+1)로 입력 시 오류 또는 입력 제한`, technique: 'BVA', type: 'boundary', valid: false, value: sized(f, f.max + 1), expected: f.ruleError, label: `${L} ${f.max + 1}자(최대+1)` });
      }
      if (f.type === 'email') add(f, 'format', { text: `${L}에 @가 없는 값 입력 시 형식 오류`, technique: 'EP', type: 'negative', valid: false, value: 'qa.example.com', expected: f.ruleError, label: `${L} 형식 오류` });
      if (f.type === 'phone') add(f, 'format', { text: `${L}에 숫자가 아닌 값 입력 시 형식 오류`, technique: 'EP', type: 'negative', valid: false, value: '010-abcd-5678', expected: f.ruleError, label: `${L} 형식 오류` });
    }
  }
  return out;
}

// ---- 승인된 조건 → TC 초안 (데이터 행) ----
// form: { name, flow, screen, submit, error, success: { kind: visible|url|text, target, value }, platforms, priority }
function entrySteps(form) {
  const steps = [];
  if (form.flow) steps.push({ action: 'flow', target: form.flow });
  if (form.screen) steps.push({ action: 'open', target: form.screen });
  return steps;
}

function successStep(form) {
  const s = form.success || {};
  if (s.kind === 'url') return { action: 'assertUrl', value: s.value };
  if (s.kind === 'text') return { action: 'assertText', target: s.target, value: s.value };
  return { action: 'assertVisible', target: s.target };
}

const fillStep = (f, value) => ({ action: f.type === 'select' ? 'select' : 'input', target: f.element, value });

function rowFor(fields, c) {
  const values = Object.fromEntries(fields.map((f) => [f.key, f.key === c.field ? c.value : validValue(f)]));
  return values;
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.map((r) => {
    let name = r.name;
    for (let i = 2; seen.has(name); i += 1) name = `${r.name.slice(0, 36)} ${i}`;
    seen.add(name);
    return { ...r, name };
  });
}

function formDrafts(form, fields, conditions) {
  const name = form.name || '입력 폼';
  const base = { platforms: form.platforms && form.platforms.length ? form.platforms : ['pc', 'mw'], precondition: form.precondition || '' };
  const drafts = [];
  const byKey = Object.fromEntries(conditions.map((c) => [c.key, c]));
  const stepsText = (rows) => [
    form.flow ? `공통 흐름 ${form.flow} 실행` : null,
    form.screen ? `${form.screen} 화면 진입` : null,
    ...fields.map((f) => `${f.label}에 ${rows ? `행의 ${f.key} 값` : `"${validValue(f)}"`} ${f.type === 'select' ? '선택' : '입력'}`),
    `${form.submit} 누르기`,
  ].filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join('\n');

  const all = byKey['valid:all'];
  if (all) {
    drafts.push({
      ...base, title: `${name} - 정상 제출`, priority: form.priority || 'P1', technique: 'EP', conditionIds: [all.id],
      steps: [...entrySteps(form), ...fields.map((f) => fillStep(f, validValue(f))), { action: 'tap', target: form.submit }, successStep(form)],
      source: { steps: stepsText(false), expected: all.text }, assumptions: [],
    });
  }

  const invalid = conditions.filter((c) => c.field && !c.valid);
  if (invalid.length) {
    const known = invalid.every((c) => c.expected);
    const rows = uniqueRows(invalid.map((c) => ({ name: c.label, values: { ...rowFor(fields, c), ...(known ? { error: c.expected } : {}) } })));
    drafts.push({
      ...base, title: `${name} - 잘못된 값 검증`, priority: 'P2', technique: [...new Set(invalid.map((c) => c.technique))].join('+'), conditionIds: invalid.map((c) => c.id),
      steps: [...entrySteps(form), ...fields.map((f) => fillStep(f, `{{row.${f.key}}}`)), { action: 'tap', target: form.submit },
        known ? { action: 'assertText', target: form.error, value: '{{row.error}}' } : { action: 'assertVisible', target: form.error }],
      dataSets: rows,
      source: { steps: stepsText(true), expected: invalid.map((c) => `${c.label}: ${c.expected || '오류 노출'}`).join('\n') },
      assumptions: known ? [] : ['조건표에 오류 문구가 없는 조건이 있어 오류 문구 노출만 확인합니다. 기획서의 오류 문구를 조건표에 넣으면 문구까지 확인합니다'],
    });
  }

  const validB = conditions.filter((c) => c.field && c.valid);
  if (validB.length) {
    drafts.push({
      ...base, title: `${name} - 허용 경계값 검증`, priority: 'P2', technique: [...new Set(validB.map((c) => c.technique))].join('+'), conditionIds: validB.map((c) => c.id),
      steps: [...entrySteps(form), ...fields.map((f) => fillStep(f, `{{row.${f.key}}}`)), { action: 'tap', target: form.submit }, successStep(form)],
      dataSets: uniqueRows(validB.map((c) => ({ name: c.label, values: rowFor(fields, c) }))),
      source: { steps: stepsText(true), expected: validB.map((c) => `${c.label}: 통과`).join('\n') }, assumptions: [],
    });
  }
  return drafts;
}

// ---- 텍스트 기획서 ----
// "# 제목" 으로 절을 나눈다. 제목이 없으면 문서 전체가 한 절
function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = { title: '(머리말)', lines: [] };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m) {
      if (cur.lines.some((l) => l.trim())) out.push(cur);
      cur = { title: m[1].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.some((l) => l.trim())) out.push(cur);
  return out.map((s, i) => ({ index: i, title: s.title, text: s.lines.join('\n') }));
}

const COND_RE = /(할\s*때|일\s*때|시[,\s]|시$|경우|하면|으면|이면|되면|이상|이하|초과|미만|최대|최소|필수|불가|제한|만\s*가능|노출|비활성|잠금|잠긴|만료)/;
// "누르면, 입력하면"처럼 "~면"으로 끝나는 조건. "화면, 측면" 같은 낱말은 뺀다
const MYEON_RE = /[가-힣]면[\s,]/;
const NOT_MYEON = /(화|측|전|후|표|정|양|장|단|지|국|내|외)면/g;
const isCondition = (line) => COND_RE.test(line) || MYEON_RE.test(line.replace(NOT_MYEON, ''));
const AMBIG = [
  [/(^|\s)등(\s|$|[,.)]|을|의|이|은|도|과)/, '등'], [/적절(히|한)/, '적절히'], [/(빠르게|신속(히|하게))/, '빠르게'], [/일부/, '일부'], [/추후/, '추후'],
  [/협의/, '협의'], [/(TBD|TBC|미정)/i, '미정'], [/가능한\s*한/, '가능한 한'], [/필요\s*시/, '필요 시'], [/상황에\s*따라/, '상황에 따라'], [/(대략|약\s*\d)/, '대략'],
];
const NEG_RE = /(불가|실패|오류|에러|제한|잠금|잠긴|초과|미만|없는|없으면|않|틀린|잘못|만료|차단|거부|비어|비우|빈\s*값|누락)/;
const HIGH_RE = /(결제|인증|로그인|비밀번호|보안|개인정보|금액|환불|잠금|주문|탈퇴)/;
const LOW_RE = /(문구|안내|색상|정렬|디자인|툴팁|아이콘)/;
const STATE_RE = /(상태|잠금|만료|대기|완료|취소|활성|비활성).*(되면|변경|전환|바뀌)/;

function cleanLine(line) {
  return line.trim().replace(/^([-*•·▪■□▶]|\d+[.)])\s+/, '').trim();
}

function boundaryOf(text) {
  const t = String(text);
  const unitRe = '(자|글자|자리|byte|바이트|개|회|원|일|분|초|세)?';
  let min = null;
  let max = null;
  let unit = '';
  const range = t.match(new RegExp(`(\\d+)\\s*${unitRe}\\s*[~∼-]\\s*(\\d+)\\s*${unitRe}`));
  if (range) { min = Number(range[1]); max = Number(range[3]); unit = range[2] || range[4] || ''; }
  for (const m of t.matchAll(new RegExp(`(\\d+)\\s*${unitRe}\\s*(이상|이하|초과|미만|까지|이내)`, 'g'))) {
    const n = Number(m[1]);
    unit = unit || m[2] || '';
    if (m[3] === '이상') min = n;
    else if (m[3] === '초과') min = n + 1;
    else if (m[3] === '이하' || m[3] === '까지' || m[3] === '이내') max = n;
    else max = n - 1;
  }
  for (const m of t.matchAll(new RegExp(`(최대|최소)\\s*(\\d+)\\s*${unitRe}`, 'g'))) {
    if (m[1] === '최대') max = Number(m[2]); else min = Number(m[2]);
    unit = unit || m[3] || '';
  }
  if (min === null && max === null) return null;
  return { min, max, unit, length: /^(자|글자|자리|byte|바이트)$/.test(unit) };
}

function classify(text) {
  const b = boundaryOf(text);
  const technique = b ? 'BVA' : STATE_RE.test(text) ? 'ST' : (text.match(/(경우|이면|하면|시[,\s])/g) || []).length >= 2 || /(및|그리고|또는|이거나)/.test(text) ? 'DT' : 'EP';
  const type = b ? 'boundary' : /(권한|관리자|회원만|비회원|로그인한)/.test(text) ? 'permission' : NEG_RE.test(text) ? 'negative' : 'positive';
  // 예외 처리 문장은 "문구"가 들어 있어도 표시 문제가 아니라 기능이므로 P2
  const priority = HIGH_RE.test(text) ? 'P1' : NEG_RE.test(text) || b ? 'P2' : LOW_RE.test(text) ? 'P3' : 'P2';
  return { technique, type, priority, boundary: b };
}

// specs: [{ id, name, text }] (텍스트만), scope: Set("S1#0") 또는 null(전체)
function scanSpecs(specs, scope) {
  const conditions = [];
  const questions = [];
  const policies = new Set();
  const seen = new Set();
  for (const s of specs) {
    for (const sec of splitSections(s.text)) {
      if (scope && !scope.has(`${s.id}#${sec.index}`)) continue;
      for (const raw of sec.text.split(/\r?\n|(?<=[.!?。])\s+/)) {
        const line = cleanLine(raw);
        if (line.length < 4 || /^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)*\|?$/.test(line)) continue;
        (line.match(POLICY_RE) || []).forEach((p) => policies.add(p));
        const policyId = (line.match(POLICY_RE) || [''])[0];
        const evidence = [{ doc: s.id, specName: s.name, policyId, quote: line, page: -1, verified: true }];
        for (const [re, word] of AMBIG) {
          if (re.test(line)) { questions.push({ text: `"${word}"의 기준이 정해져 있지 않습니다. 범위·값을 확인해 주세요`, doc: s.id, specName: s.name, quote: line, section: sec.title }); break; }
        }
        if (!isCondition(line) || seen.has(normText(line))) continue;
        seen.add(normText(line));
        conditions.push({ text: line, ...classify(line), evidence, section: sec.title, assumption: '' });
      }
    }
  }
  return { conditions, questions, policies: [...policies].sort() };
}

// 경계 조건을 조건표 한 줄로 바꿔 보여준다 (요소는 QA가 채운다)
function formRowHint(c) {
  const b = c.boundary;
  if (!b) return '';
  const label = (c.text.replace(POLICY_RE, '').trim().match(/^([가-힣A-Za-z ]{1,12}?)(은|는|이|가|을|를)\s/) || [])[1] || '필드';
  return [label.trim(), '', b.length ? '문자' : '숫자', '', b.min === null ? '' : b.min, b.max === null ? '' : b.max, '', '', '', ''].join('\t');
}

module.exports = {
  TECHNIQUES, TYPES, POLICY_RE, FORM_HEADER, normText, josa, parseForm, validValue, formConditions, formDrafts,
  splitSections, scanSpecs, boundaryOf, classify, formRowHint, textOf, emailOf,
};
