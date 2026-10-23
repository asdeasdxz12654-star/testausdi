// TC 자동 작성. 기획서·화면·입력 조건표에서 ① 테스트 조건 ② TC 초안을 만들고, QA가 승인한 것만 data/tcs에 반영한다.
// 방법: 규칙(rules, 무료) / Claude Code(claude-code, 구독 안에서 요청·응답 파일). 유료 API는 쓰지 않는다.
// AI 답은 그대로 믿지 않는다: 인용은 원문과 대조해 못 찾으면 버리고, 스텝은 validateTc로 검사해 실행 가능 여부를 정한다.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const materials = require('./materials');
const td = require('./testdesign');
const { ACTIONS, PLATFORMS } = require('./actions');
const { validateTc, describeStep, PRIORITIES } = require('./tc');
const { convertTc } = require('./importer');
const { similarity } = require('./heal');

const DIR = () => path.join(P.STATE, 'generate');
const projDir = (id) => { store.assertId(id, '생성 프로젝트 ID'); return path.join(DIR(), id); };
const projFile = (id) => path.join(projDir(id), 'project.json');
const KEY_RE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;
const { normText } = td;
const REVIEW = ['pending', 'approved', 'inquiry', 'rejected'];
const DUP_MIN = 0.8;
const MAX_CONDITIONS = 60;

// ---- 프로젝트 ----
function listProjects() {
  if (!fs.existsSync(DIR())) return [];
  return fs.readdirSync(DIR())
    .filter((d) => fs.existsSync(path.join(DIR(), d, 'project.json')))
    .map((d) => {
      const p = store.readJson(path.join(DIR(), d, 'project.json'));
      return {
        id: p.id, name: p.name, createdAt: p.createdAt, specs: p.specs.length, frames: p.frames.length,
        conditions: p.conditions.length, drafts: p.drafts.length, applied: p.drafts.filter((x) => x.appliedAs).length,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getProject(id) {
  const f = projFile(id);
  if (!fs.existsSync(f)) throw new HttpError(404, `생성 프로젝트를 찾을 수 없습니다: ${id}`);
  return store.readJson(f);
}

const saveProject = (p) => store.writeJson(projFile(p.id), p);

function createProject(name) {
  const id = `G${Date.now().toString(36)}`;
  const p = {
    id, name: String(name || '').trim() || '새 TC 작성', createdAt: new Date().toISOString(), specs: [], frames: [], figma: null,
    scope: { sections: [], note: '' },
    form: { name: '', text: '', flow: '', screen: '', submit: '', error: '', success: { kind: 'visible', target: '', value: '' }, platforms: ['pc', 'mw'], priority: 'P1', precondition: '' },
    examples: [], idPrefix: 'TC-GEN-', conditions: [], questions: [], policies: [], drafts: [], seq: { c: 0, d: 0 }, claudeCode: null, lastRun: null,
  };
  fs.mkdirSync(projDir(id), { recursive: true });
  saveProject(p);
  return p;
}

function deleteProject(id) {
  getProject(id);
  fs.rmSync(projDir(id), { recursive: true, force: true });
}

const s = (v) => (v === undefined || v === null ? '' : String(v).trim());

function updateProject(id, patch) {
  const p = getProject(id);
  if (patch.name !== undefined) p.name = s(patch.name) || p.name;
  if (patch.idPrefix !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(s(patch.idPrefix))) throw new HttpError(400, 'TC ID 접두어는 영문으로 시작하고 영문·숫자·-·_ 만 씁니다 (예: TC-SIGNUP-)');
    p.idPrefix = s(patch.idPrefix);
  }
  if (patch.scope) {
    const valid = new Set(sections(p).map((x) => x.key));
    p.scope = { sections: (patch.scope.sections || []).filter((k) => valid.has(k)), note: s(patch.scope.note).slice(0, 2000) };
  }
  if (Array.isArray(patch.examples)) {
    const known = new Set(store.listTcs().map((t) => t.id));
    p.examples = patch.examples.filter((t) => known.has(t)).slice(0, 2);
  }
  if (patch.form) {
    const f = patch.form;
    const succ = f.success || {};
    p.form = {
      name: s(f.name).slice(0, 60), text: String(f.text || '').slice(0, 20000), flow: s(f.flow), screen: s(f.screen), submit: s(f.submit), error: s(f.error),
      success: { kind: ['visible', 'url', 'text'].includes(succ.kind) ? succ.kind : 'visible', target: s(succ.target), value: s(succ.value) },
      platforms: (f.platforms || []).filter((x) => PLATFORMS.includes(x)),
      priority: PRIORITIES.includes(f.priority) ? f.priority : 'P1', precondition: s(f.precondition).slice(0, 200),
    };
  }
  saveProject(p);
  return view(id);
}

// ---- 자료 ----
function addFile(id, file) {
  const p = getProject(id);
  materials.addFile(projDir(id), p, file);
  saveProject(p);
  return view(id);
}

async function addFigma(id, url, deps = {}) {
  const p = getProject(id);
  const ai = require('./ai');
  const got = await materials.addFigma(projDir(id), p, url, { figma: deps.figma, token: ai.getSettings().figmaToken, figmaOptions: deps.figmaOptions });
  saveProject(p);
  return { ...view(id), ...got };
}

function removeFile(id, fileId) {
  const p = getProject(id);
  const item = materials.removeFile(projDir(id), p, fileId);
  if (fileId.startsWith('S')) p.scope.sections = p.scope.sections.filter((k) => !k.startsWith(`${item.id}#`));
  saveProject(p);
  return view(id);
}

// 텍스트 기획서의 절 (범위 고르기용)
function sections(p) {
  return p.specs.filter((x) => x.kind === 'text').flatMap((spec) => td.splitSections(spec.text).map((sec) => ({
    key: `${spec.id}#${sec.index}`, spec: spec.id, specName: spec.name, title: sec.title, chars: sec.text.trim().length,
  })));
}

const scopeSet = (p) => (p.scope.sections.length ? new Set(p.scope.sections) : null);

// ---- 입력 조건표 검사 ----
// 요소 맵에 없는 이름은 새 요소로 만든다 (반영할 때 web: null로 추가, 요소 맵 화면에서 식별자를 채운다)
function formState(p, elements, flows) {
  const f = p.form;
  const parsed = td.parseForm(f.text);
  const errors = [...parsed.errors];
  const newElements = {};
  if (!parsed.fields.length) return { fields: [], errors, newElements, ready: false };
  const need = (key, what, label, screen) => {
    if (!key) { errors.push(`${what}을(를) 정하세요`); return; }
    const exists = screen ? elements.screens[key] : elements.elements[key];
    if (exists) return;
    if (!KEY_RE.test(key)) { errors.push(`${what} "${key}"는 요소 맵에 없고 "화면.요소" 형식도 아닙니다`); return; }
    newElements[key] = { label, screen: !!screen };
  };
  if (f.flow && !flows[f.flow]) errors.push(`공통 흐름 "${f.flow}"이(가) 없습니다`);
  if (!f.flow && !f.screen) errors.push('진입 방법(공통 흐름이나 화면)을 하나 이상 정하세요');
  if (f.screen) need(f.screen, '진입 화면', f.name || f.screen, true);
  parsed.fields.forEach((x) => need(x.element, `${x.no}행 요소`, x.label.endsWith('입력창') || x.type === 'select' ? x.label : `${x.label} 입력창`));
  need(f.submit, '제출 버튼', '제출 버튼');
  if (parsed.fields.some((x) => x.required || x.min !== null || x.max !== null || ['email', 'phone', 'number'].includes(x.type))) need(f.error, '오류 문구 요소', `${f.name || '입력'} 오류 문구`);
  if (f.success.kind === 'url') { if (!f.success.value) errors.push('성공 확인 주소 조각을 입력하세요'); } else need(f.success.target, '성공 확인 요소', '성공 확인 요소');
  if (f.success.kind === 'text' && !f.success.value) errors.push('성공 확인 문구를 입력하세요');
  if (!f.platforms.length) errors.push('플랫폼을 하나 이상 고르세요');
  return { fields: parsed.fields, errors, newElements, ready: errors.length === 0 };
}

// ---- 조건 저장 (다시 뽑아도 검토 결과 유지) ----
// key가 같은 조건은 ID와 검토를 이어받고, 검토 대기 중인 옛 조건은 지운다. 검토한 조건은 남긴다
function mergeConditions(p, source, list) {
  const bySrc = (c) => (source === 'rules' ? c.source === 'form' || c.source === 'spec' : c.source === source);
  const old = p.conditions.filter(bySrc);
  const keep = p.conditions.filter((c) => !bySrc(c));
  const oldByKey = Object.fromEntries(old.map((c) => [c.key, c]));
  const used = new Set();
  const out = list.slice(0, MAX_CONDITIONS).map((c) => {
    const prev = oldByKey[c.key];
    if (prev) used.add(prev.id);
    if (!prev) p.seq.c += 1;
    return { ...c, id: prev ? prev.id : `C${p.seq.c}`, review: prev ? prev.review : { status: 'pending', note: '' } };
  });
  const reviewedLeft = old.filter((c) => !used.has(c.id) && c.review.status !== 'pending');
  p.conditions = [...keep, ...out, ...reviewedLeft];
  return { added: out.length, dropped: Math.max(0, list.length - MAX_CONDITIONS) };
}

// ---- 규칙 기반: 조건 ----
function rulesConditions(id) {
  const p = getProject(id);
  const elements = store.getElements();
  const flows = store.getFlows();
  const textSpecs = p.specs.filter((x) => x.kind === 'text');
  const scan = td.scanSpecs(textSpecs, scopeSet(p));
  const warnings = [];
  const list = [];
  const form = formState(p, elements, flows);
  // 조건표 조건의 근거로 쓴 기획서 문장은 따로 조건으로 만들지 않는다 (같은 내용이 두 번 나오지 않게)
  const anchored = new Set();
  if (p.form.text.trim()) {
    if (form.fields.length) {
      for (const c of td.formConditions(p.form, form.fields)) {
        // 같은 필드를 말하는 기획서 문장을 근거로 붙인다 (원문 대조됨). 기대 문구가 든 문장을 먼저,
        // 조건표에 없는 경계(최소·최대)가 든 문장은 별도 조건으로 남긴다
        const field = c.field && form.fields.find((x) => x.key === c.field);
        const hits = field ? scan.conditions.filter((sc) => normText(sc.text).includes(normText(field.label))
          && !(sc.boundary && field.min === null && field.max === null)) : [];
        hits.sort((a, b) => Number(!!c.expected && normText(b.text).includes(normText(c.expected))) - Number(!!c.expected && normText(a.text).includes(normText(c.expected))));
        const used = hits.slice(0, 2);
        used.forEach((h) => anchored.add(h.text));
        list.push({
          source: 'form', key: `form:${c.key}`, text: c.text, technique: c.technique, type: c.type,
          priority: c.type === 'positive' && !c.field ? p.form.priority : 'P2', evidence: used.flatMap((h) => h.evidence),
          assumption: !c.valid && !c.expected ? '오류 문구가 조건표에 없습니다' : '', form: { key: c.key, field: c.field, valid: c.valid, value: c.value, expected: c.expected, label: c.label },
        });
      }
    }
    if (form.errors.length) warnings.push(...form.errors.map((e) => `조건표: ${e}`));
  }
  for (const c of scan.conditions) {
    if (anchored.has(c.text)) continue;
    list.push({ source: 'spec', key: `spec:${normText(c.text)}`, text: c.text, technique: c.technique, type: c.type, priority: c.priority, evidence: c.evidence, assumption: '', boundary: c.boundary, hint: td.formRowHint(c), section: c.section });
  }
  if (p.specs.some((x) => x.kind !== 'text')) warnings.push('PDF·이미지 기획서는 규칙 기반으로 읽지 못합니다. 텍스트(.txt/.md)로 저장해 올리거나 Claude Code로 요청하세요');
  if (!list.length) throw new HttpError(400, warnings.length ? warnings.join('\n') : '조건을 뽑을 자료가 없습니다. 텍스트 기획서를 올리거나 입력 조건표를 채우세요');
  const r = mergeConditions(p, 'rules', list);
  p.questions = [...p.questions.filter((q) => q.source !== 'rules'), ...scan.questions.map((q) => ({ ...q, source: 'rules' }))];
  p.policies = scan.policies;
  p.lastRun = { at: new Date().toISOString(), method: 'rules', stage: 'conditions', warnings: [...warnings, ...(r.dropped ? [`조건이 많아 ${MAX_CONDITIONS}개까지만 남겼습니다. 범위를 나눠 주세요`] : [])] };
  saveProject(p);
  return view(id);
}

// ---- 규칙 기반: TC 초안 ----
function newDraft(p, method, d) {
  p.seq.d += 1;
  return {
    id: `D${p.seq.d}`, method, title: d.title, priority: d.priority, precondition: d.precondition || '', platforms: d.platforms,
    steps: d.steps || [], ...(d.dataSets && d.dataSets.length ? { dataSets: d.dataSets } : {}),
    source: { steps: d.source ? d.source.steps : '', expected: d.source ? d.source.expected : '' },
    conditionIds: d.conditionIds, technique: d.technique, assumptions: d.assumptions || [], newElements: d.newElements || {},
    notes: d.notes || [], review: { status: 'pending', note: '' },
  };
}

// 검토 전 초안만 바꾼다. 검토·반영한 초안은 남긴다
function replaceDrafts(p, method, drafts) {
  p.drafts = [...p.drafts.filter((d) => d.method !== method || d.review.status !== 'pending' || d.appliedAs), ...drafts];
}

function rulesDrafts(id) {
  const p = getProject(id);
  const elements = store.getElements();
  const flows = store.getFlows();
  const approved = p.conditions.filter((c) => c.review.status === 'approved' && (c.source === 'form' || c.source === 'spec'));
  if (!approved.length) throw new HttpError(400, '승인한 규칙 기반 조건이 없습니다. ② 테스트 조건에서 먼저 승인하세요');
  const done = new Set(p.drafts.filter((d) => d.review.status !== 'pending' || d.appliedAs).flatMap((d) => d.conditionIds));
  const out = [];
  const formConds = approved.filter((c) => c.source === 'form').map((c) => ({ ...c.form, id: c.id, technique: c.technique, text: c.text }));
  if (formConds.length) {
    const st = formState(p, elements, flows);
    if (!st.ready) throw new HttpError(400, `입력 조건표를 먼저 고치세요:\n${st.errors.join('\n')}`);
    for (const d of td.formDrafts(p.form, st.fields, formConds)) {
      if (d.conditionIds.every((c) => done.has(c))) continue;
      const usedKeys = new Set(d.steps.map((x) => x.target).filter(Boolean));
      const ne = Object.fromEntries(Object.entries(st.newElements).filter(([k]) => usedKeys.has(k)));
      out.push(newDraft(p, 'rules', { ...d, newElements: ne }));
    }
  }
  // 조건표가 다루지 않는 기획서 조건: 원문만 있는 초안 (스텝은 QA가 채운다)
  for (const c of approved.filter((x) => x.source === 'spec' && !done.has(x.id))) {
    out.push(newDraft(p, 'rules', {
      title: c.text.length > 60 ? `${c.text.slice(0, 58)}…` : c.text, priority: c.priority, platforms: p.form.platforms.length ? p.form.platforms : ['pc', 'mw'],
      technique: c.technique, conditionIds: [c.id], source: { steps: '', expected: c.text },
      assumptions: ['기획서 문장만 있는 초안입니다. 절차와 스텝은 TC 편집기에서 채우세요'],
    }));
  }
  replaceDrafts(p, 'rules', out);
  p.lastRun = { at: new Date().toISOString(), method: 'rules', stage: 'drafts', warnings: out.length ? [] : ['새로 만들 초안이 없습니다 (승인한 조건은 이미 초안이 있습니다)'] };
  saveProject(p);
  return view(id);
}

// ---- 품질 검사 ----
function augmented(elements, newElements) {
  const out = { screens: { ...elements.screens }, elements: { ...elements.elements } };
  for (const [k, e] of Object.entries(newElements || {})) {
    if (e.screen) out.screens[k] = out.screens[k] || { label: e.label, web: null };
    else out.elements[k] = out.elements[k] || { label: e.label, web: null, android: null, ios: null };
  }
  return out;
}

const stepSig = (steps) => steps.map((x) => `${x.action}:${x.target || ''}`).join('>');
const WEAK_RE = /^(정상(적으로)?|잘|문제\s*없|확인(한다|됨)?|동작(한다|함)?|성공)\.?$/;

function checkDraft(d, ctx) {
  const { elements, flows, schemas, tcs, drafts, conditions } = ctx;
  const aug = augmented(elements, d.newElements);
  const problems = [];
  let runnable = 'manual';
  if (d.steps.length) {
    try {
      validateTc({ ...d, id: 'DRAFT', automation: '적합' }, { elements: aug, flows, schemas });
      const webUsed = d.platforms.some((x) => x === 'pc' || x === 'mw');
      const noLocator = [...new Set(d.steps.map((x) => x.target).filter((t) => t && ((aug.elements[t] && !aug.elements[t].web) || (aug.screens[t] && !aug.screens[t].web))))];
      runnable = webUsed && noLocator.length ? 'needs-locator' : 'ok';
      if (runnable === 'needs-locator') problems.push(`식별자가 없는 요소 ${noLocator.length}개: ${noLocator.join(', ')}`);
    } catch (e) {
      runnable = 'invalid';
      problems.push(...e.message.split('\n'));
    }
  }
  const hasAssert = d.steps.some((x) => ACTIONS[x.action] && ACTIONS[x.action].assert);
  const expected = s(d.source.expected);
  // 확인 스텝이 없거나, 기대결과 문장이 "정상"처럼 막연하면 (노출 확인만 있는 스텝이 값을 검증하지 않는 경우를 잡는다)
  const weak = (d.steps.length > 0 && !hasAssert) || WEAK_RE.test(expected) || (!d.steps.length && expected.length < 4);
  const dups = [];
  const title = normText(d.title);
  for (const t of tcs) {
    const score = Math.max(similarity(title, normText(t.title)), t.steps && t.steps.length && d.steps.length && stepSig(t.steps) === stepSig(d.steps) && !d.dataSets ? 1 : 0);
    if (score >= DUP_MIN) dups.push({ id: t.id, title: t.title, score: Math.round(score * 100) / 100 });
  }
  for (const o of drafts) {
    if (o.id === d.id || o.review.status === 'rejected' || o.appliedAs) continue;
    const score = similarity(title, normText(o.title));
    if (score >= DUP_MIN) dups.push({ id: o.id, title: o.title, score: Math.round(score * 100) / 100, draft: true });
  }
  const conds = d.conditionIds.map((c) => conditions.find((x) => x.id === c)).filter(Boolean);
  const ev = conds.flatMap((c) => c.evidence || []);
  const evidence = ev.some((e) => e.verified === true) ? 'verified' : ev.length ? 'unverified' : conds.some((c) => c.source === 'form') ? 'form' : 'none';
  const assumptions = [...new Set([...d.assumptions, ...conds.map((c) => c.assumption).filter(Boolean)])];
  return { runnable, problems, weak, duplicates: dups.sort((a, b) => b.score - a.score).slice(0, 3), evidence, assumptions, newElements: Object.keys(d.newElements || {}).length };
}

// ---- Claude Code 연계 ----
const ccDir = (id) => path.join(projDir(id), 'claude-code');

const RULES = [
  '## 역할',
  '당신은 테스트 설계를 돕는 QA 분석가입니다. ISTQB CTFL 4.0의 테스트 기법(동등 분할 EP, 경계값 분석 BVA, 결정 테이블 DT, 상태 전이 ST, 오류 추정 EG, 유스케이스 UC)을 씁니다.',
  '',
  '## 지켜야 할 것',
  '- 아래 자료(범위 안의 기획서·화면)만 근거로 씁니다. 자료에 없는 규칙·문구·숫자를 지어내지 않습니다.',
  '- 자료로 정할 수 없는 부분은 assumption(가정)에 적고, 기획자에게 물어볼 것은 questions에 적습니다.',
  '- evidence.quote는 기획서 문장을 글자 그대로 옮깁니다. 요약하거나 고쳐 쓰지 않습니다. AutoTC가 원문과 대조해 못 찾은 인용은 버립니다.',
  '- doc에는 자료에 붙은 id(S1, F1 …)만 씁니다. policyId는 기획서에 정책 번호가 있을 때만 씁니다. page는 PDF 쪽 번호, 없으면 -1입니다.',
  '- 범위 밖 기능은 다루지 않습니다. 같은 내용을 두 번 쓰지 않고, 입력값만 다른 조건은 하나로 묶은 뒤 값을 나열합니다.',
  '- 정상만이 아니라 예외·경계·권한·오류 처리 조건을 함께 찾습니다. 확신도 같은 자기 평가는 쓰지 않습니다 (AutoTC가 규칙으로 검사합니다).',
];

function scopeMaterials(p, abs) {
  const set = scopeSet(p);
  const lines = [];
  for (const spec of p.specs) {
    if (spec.kind === 'text') {
      const secs = td.splitSections(spec.text).filter((sec) => !set || set.has(`${spec.id}#${sec.index}`));
      if (!secs.length) continue;
      lines.push(`### ${spec.id} "${spec.name}" (텍스트, 범위 안의 절만)`, '', ...secs.map((sec) => `#### ${sec.title}\n${sec.text.trim()}\n`));
    } else {
      lines.push(`- ${spec.id} "${spec.name}" (${spec.kind}): ${abs(spec.file)} — 파일을 열어 읽으세요${p.scope.note ? '. 범위 설명에 맞는 부분만 다룹니다' : ''}`);
    }
  }
  if (p.frames.length) {
    lines.push('', '### 화면 디자인 (이미지 파일을 열어서 보세요)');
    p.frames.forEach((f) => lines.push(`- ${f.id} "${f.name}": ${abs(f.file)}${f.texts && f.texts.length ? `\n  피그마 텍스트: ${JSON.stringify(f.texts.map((t) => t.text))}` : ''}`));
  }
  return lines;
}

function elementLines(elements, flows) {
  return [
    ...Object.entries(elements.screens).map(([k, x]) => `- 화면 ${k}: ${x.label}`),
    ...Object.entries(elements.elements).map(([k, x]) => `- ${k}: ${x.label}`),
    ...Object.entries(flows).map(([k, x]) => `- 공통 흐름 ${k}: ${x.label}`),
  ];
}

function dataKeys(obj, prefix = '') {
  return Object.entries(obj || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && v.secret === undefined ? dataKeys(v, `${prefix}${k}.`) : [`{{${prefix}${k}}}`]));
}

function examplesOf(p) {
  const all = store.listTcs();
  const picked = p.examples.length ? all.filter((t) => p.examples.includes(t.id))
    : all.filter((t) => t.automation !== '수동 유지' && t.steps.some((x) => ACTIONS[x.action] && ACTIONS[x.action].assert) && !(t.tags || []).includes('demo-bug')).slice(0, 2);
  return picked.map(({ id, title, priority, platforms, precondition, steps, dataSets }) => ({ id, title, priority, platforms, precondition, steps, ...(dataSets ? { dataSets } : {}) }));
}

function exportForClaudeCode(id, { stage } = {}) {
  const p = getProject(id);
  if (!['conditions', 'drafts'].includes(stage)) throw new HttpError(400, 'stage는 conditions 또는 drafts입니다');
  if (!p.specs.length && !p.frames.length) throw new HttpError(400, '기획서나 화면을 하나 이상 올려 주세요');
  const elements = store.getElements();
  const flows = store.getFlows();
  const dir = ccDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const abs = (f) => path.join(projDir(id), f);
  const responseFile = path.join(dir, `${stage}.response.json`);
  const head = [`# AutoTC TC 자동 작성 요청 · ${p.name} · ${stage === 'conditions' ? '1단계: 테스트 조건' : '2단계: TC 초안'}`, '', '이 파일은 AutoTC가 만든 요청입니다. 아래 자료를 직접 읽고, 맨 아래 형식대로 결과 파일을 써 주세요.', '', ...RULES, ''];
  const scope = ['## 범위', p.scope.note ? `범위 설명: ${p.scope.note}` : '범위 설명: (없음 — 자료 전체)', '', '## 자료', ...scopeMaterials(p, abs), ''];
  let md;
  let ids = [];
  if (stage === 'conditions') {
    const existing = p.conditions.filter((c) => c.review.status !== 'rejected');
    md = [
      ...head, ...scope,
      '## 요소 맵 (참고)', ...elementLines(elements, flows), '',
      existing.length ? '## 이미 있는 조건 (같은 내용은 다시 쓰지 마세요)' : null, ...existing.map((c) => `- ${c.text}`), existing.length ? '' : null,
      '## 할 일',
      '범위 안의 기능에서 테스트 조건(무엇을 확인할지)을 찾으세요. TC 절차는 아직 쓰지 않습니다. 조건은 30개 이하로, 위험이 큰 것부터 씁니다.',
      'priority: P1(결제·인증·개인정보·데이터 손실처럼 실패하면 업무가 막히는 것) / P2(주요 기능) / P3(문구·표시).',
      '',
      '## 결과 파일',
      `다음 경로에 UTF-8 JSON으로 저장하세요: ${responseFile}`,
      '```',
      '{',
      '  "conditions": [ { "text": "조건 한 문장", "technique": "EP|BVA|DT|ST|EG|UC", "type": "positive|negative|boundary|permission|exception", "priority": "P1|P2|P3", "evidence": [ { "doc": "S1", "policyId": "", "quote": "기획서 원문 그대로", "page": -1 } ], "assumption": "" } ],',
      '  "questions": [ { "text": "기획자에게 물어볼 내용", "doc": "S1", "quote": "관련 원문 (없으면 빈 문자열)" } ]',
      '}',
      '```',
    ].filter((x) => x !== null);
  } else {
    const approved = p.conditions.filter((c) => c.review.status === 'approved');
    if (!approved.length) throw new HttpError(400, '승인한 조건이 없습니다. ② 테스트 조건에서 먼저 승인하세요');
    ids = approved.map((c) => c.id);
    const actions = Object.entries(ACTIONS).map(([k, a]) => `- ${k}: ${a.label}${a.target ? ` · target=${a.target}${a.targetOptional ? '(생략 가능)' : ''}` : ''}${a.value ? ` · value${a.valueOptional ? '(생략 가능)' : ''}` : ''}${a.options ? ` (${a.options.join('|')})` : ''}${a.body ? ' · body(JSON 문자열)' : ''}`);
    md = [
      ...head, ...scope,
      '## 승인된 테스트 조건 (이것만 TC로 만듭니다)', ...approved.map((c) => `- ${c.id} [${c.technique}/${c.type}/${c.priority}] ${c.text}${c.assumption ? ` (가정: ${c.assumption})` : ''}`), '',
      '## AutoTC TC 형식',
      '스텝 액션 (target: screen=요소 맵의 화면, element=요소 맵의 요소, flow=공통 흐름, path=응답 JSON 경로, schema=data/schemas 이름):', ...actions, '',
      '요소 맵 (target에 쓰는 이름):', ...elementLines(elements, flows), '',
      `테스트 데이터 (값 대신 이 이름을 씁니다): ${dataKeys(store.getTestData()).join(', ') || '(없음)'}`,
      '입력값만 다른 TC는 하나로 묶고 dataSets 행으로 나눕니다. 스텝 값에 {{row.키}}를 쓰고 행마다 values에 같은 키를 넣습니다.',
      '요소 맵에 없는 요소가 필요하면 newElements에 "화면.요소" 형식의 영문 camelCase 이름과 표시 이름을 적고 스텝 target에 그 이름을 씁니다 (화면이면 key를 screen.으로 시작).',
      '구조화 스텝을 확신할 수 없으면 steps는 빈 배열로 두고 stepsText·expectedText만 씁니다 (QA가 채웁니다).',
      '',
      '## 팀 TC 예시 (형식과 상세 수준을 맞추세요)', '```json', JSON.stringify(examplesOf(p), null, 2), '```', '',
      '## 할 일',
      '승인된 조건마다 TC를 만드세요. 한 TC가 여러 조건을 다뤄도 되며 conditionIds에 모두 적습니다. 기대결과는 기획서·화면에서 확인한 문구와 상태로 씁니다 ("정상 동작" 같은 막연한 기대결과 금지).',
      '',
      '## 결과 파일',
      `다음 경로에 UTF-8 JSON으로 저장하세요: ${responseFile}`,
      '```',
      '{',
      '  "drafts": [ { "title": "", "priority": "P1|P2|P3", "platforms": ["pc", "mw"], "precondition": "", "conditionIds": ["C1"], "technique": "EP", "stepsText": "1. ...\\n2. ...", "expectedText": "...", "steps": [ { "action": "open", "target": "screen.login" } ], "dataSets": [ { "name": "행 이름", "values": { "키": "값" } } ], "newElements": [ { "key": "login.findPw", "label": "비밀번호 찾기 링크" } ], "assumptions": [] } ]',
      '}',
      '```',
    ];
  }
  const requestFile = path.join(dir, `${stage}.request.md`);
  fs.writeFileSync(requestFile, md.join('\n'), 'utf8');
  if (fs.existsSync(responseFile)) fs.renameSync(responseFile, path.join(dir, `${stage}.response-${Date.now()}.json.bak`));
  p.claudeCode = { stage, requestFile, responseFile, conditionIds: ids, at: new Date().toISOString() };
  saveProject(p);
  return { ...view(id), prompt: ccPrompt(p.claudeCode) };
}

const ccPrompt = (cc) => (cc ? `${cc.requestFile} 파일을 읽고, 안의 지시대로 자료를 분석해서 ${cc.responseFile} 에 결과를 저장해 줘.` : '');

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 인용 대조: 텍스트 기획서는 원문에서 직접 찾고, 못 찾으면 버린다. PDF·이미지는 대조할 수 없음(null)
function verifyEvidence(p, list, warnings) {
  const specs = Object.fromEntries(p.specs.map((x) => [x.id, x]));
  const out = [];
  for (const e of arr(list)) {
    const spec = specs[str(e && e.doc)];
    const quote = str(e && e.quote);
    if (!spec || !quote) { warnings.push(`근거 문서 id(${str(e && e.doc) || '없음'})가 올바르지 않아 버렸습니다`); continue; }
    if (spec.kind === 'text' && !normText(spec.text).includes(normText(quote))) { warnings.push(`기획서 ${spec.name}에서 찾을 수 없는 인용을 버렸습니다: "${quote.slice(0, 40)}"`); continue; }
    out.push({ doc: spec.id, specName: spec.name, policyId: (str(e.policyId).match(td.POLICY_RE) || [''])[0], quote, page: Number.isInteger(e.page) ? e.page : -1, verified: spec.kind === 'text' ? true : null });
  }
  return out;
}

function readResponse(p) {
  if (!p.claudeCode) throw new HttpError(400, '먼저 "요청 파일 만들기"를 누르세요');
  if (!fs.existsSync(p.claudeCode.responseFile)) throw new HttpError(404, `응답 파일이 아직 없습니다: ${p.claudeCode.responseFile}`);
  try {
    return JSON.parse(fs.readFileSync(p.claudeCode.responseFile, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new HttpError(400, `응답 파일의 JSON 형식이 올바르지 않습니다: ${e.message}`);
  }
}

function importConditions(p, data) {
  const warnings = [];
  const list = arr(data.conditions).filter((c) => c && str(c.text)).map((c) => {
    const evidence = verifyEvidence(p, c.evidence, warnings);
    const assumption = str(c.assumption) || (evidence.length ? '' : '기획서 근거를 찾지 못했습니다 (AI 추정)');
    return {
      source: 'claude-code', key: `cc:${normText(c.text)}`, text: str(c.text).slice(0, 300),
      technique: td.TECHNIQUES[c.technique] ? c.technique : 'EP', type: td.TYPES[c.type] ? c.type : 'positive',
      priority: PRIORITIES.includes(c.priority) ? c.priority : 'P2', evidence, assumption,
    };
  });
  // 이미 있는 조건과 같은 문장은 받지 않는다
  const have = new Set(p.conditions.filter((c) => c.source !== 'claude-code').map((c) => normText(c.text)));
  const fresh = list.filter((c) => !have.has(normText(c.text)));
  if (fresh.length < list.length) warnings.push(`이미 있는 조건과 같은 ${list.length - fresh.length}개는 건너뛰었습니다`);
  const r = mergeConditions(p, 'claude-code', fresh);
  if (r.dropped) warnings.push(`조건이 많아 ${MAX_CONDITIONS}개까지만 받았습니다`);
  const qWarn = [];
  const questions = arr(data.questions).filter((q) => q && str(q.text)).map((q) => {
    const ev = str(q.quote) ? verifyEvidence(p, [{ doc: q.doc, quote: q.quote }], qWarn)[0] : null;
    return { text: str(q.text).slice(0, 300), doc: ev ? ev.doc : '', specName: ev ? ev.specName : '', quote: ev ? ev.quote : '', source: 'claude-code' };
  });
  p.questions = [...p.questions.filter((q) => q.source !== 'claude-code'), ...questions];
  return { imported: r.added, warnings: [...warnings, ...qWarn] };
}

function normalizeStep(x) {
  if (!x || !ACTIONS[x.action]) return null;
  const out = { action: x.action };
  if (str(x.target)) out.target = str(x.target);
  if (x.value !== undefined && x.value !== null && String(x.value) !== '') out.value = String(x.value);
  if (str(x.body)) out.body = str(x.body);
  return out;
}

function importDrafts(p, data) {
  const elements = store.getElements();
  const flows = store.getFlows();
  const schemas = store.getSchemas();
  const warnings = [];
  const approved = new Set(p.conditions.filter((c) => c.review.status === 'approved').map((c) => c.id));
  const out = [];
  for (const [i, raw] of arr(data.drafts).entries()) {
    const no = i + 1;
    if (!raw || !str(raw.title)) { warnings.push(`${no}번째 초안: 제목이 없어 버렸습니다`); continue; }
    const conditionIds = arr(raw.conditionIds).filter((c) => approved.has(c));
    if (arr(raw.conditionIds).length > conditionIds.length) warnings.push(`${no}번째 초안: 승인하지 않은 조건 id를 뺐습니다`);
    const newElements = {};
    for (const e of arr(raw.newElements)) {
      const key = str(e && e.key);
      if (!KEY_RE.test(key)) { if (key) warnings.push(`${no}번째 초안: 요소 이름 형식이 아니라 버렸습니다 (${key})`); continue; }
      const screen = key.startsWith('screen.');
      if (screen ? elements.screens[key] : elements.elements[key]) continue;
      newElements[key] = { label: str(e.label) || key, screen };
    }
    const d = {
      title: str(raw.title).slice(0, 120), priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'P2',
      platforms: arr(raw.platforms).filter((x) => PLATFORMS.includes(x)), precondition: str(raw.precondition).slice(0, 200),
      technique: td.TECHNIQUES[raw.technique] ? raw.technique : (str(raw.technique).split('+').filter((t) => td.TECHNIQUES[t]).join('+') || 'EP'),
      conditionIds, newElements, assumptions: arr(raw.assumptions).map(str).filter(Boolean),
      source: { steps: str(raw.stepsText), expected: str(raw.expectedText) },
      dataSets: arr(raw.dataSets).filter((r) => r && str(r.name)).map((r) => ({ name: str(r.name).slice(0, 40), values: Object.fromEntries(Object.entries(r.values || {}).map(([k, v]) => [k, String(v)])) })),
      notes: [],
    };
    if (!d.platforms.length) d.platforms = p.form.platforms.length ? p.form.platforms : ['pc', 'mw'];
    // 구조화 스텝 → 안 되면 자연어 절차에서 다시 변환 → 그래도 안 되면 원문만 (수동 유지)
    const aug = augmented(elements, newElements);
    const tryValid = (steps) => {
      try { validateTc({ id: 'DRAFT', title: d.title, priority: d.priority, platforms: d.platforms, steps, dataSets: d.dataSets }, { elements: aug, flows, schemas }); return null; } catch (e) { return e.message; }
    };
    const steps = arr(raw.steps).map(normalizeStep);
    let err = steps.length ? (steps.includes(null) ? '알 수 없는 액션이 있습니다' : tryValid(steps)) : null;
    if (steps.length && !err) d.steps = steps;
    else {
      if (err) d.notes.push(`구조화 스텝을 쓸 수 없습니다: ${err.split('\n')[0]}`);
      const conv = d.source.steps ? convertTc(d.source.steps, d.source.expected, aug) : null;
      err = conv && conv.convertible ? tryValid(conv.steps) : 'x';
      if (conv && conv.convertible && !err) { d.steps = conv.steps; d.notes.push('자연어 절차에서 스텝을 다시 만들었습니다'); } else d.steps = [];
    }
    if (!d.steps.length) delete d.dataSets;
    out.push(newDraft(p, 'claude-code', d));
  }
  replaceDrafts(p, 'claude-code', out);
  return { imported: out.length, warnings };
}

function importClaudeCode(id) {
  const p = getProject(id);
  const data = readResponse(p);
  const r = p.claudeCode.stage === 'conditions' ? importConditions(p, data) : importDrafts(p, data);
  p.lastRun = { at: new Date().toISOString(), method: 'claude-code', stage: p.claudeCode.stage, warnings: r.warnings };
  saveProject(p);
  return { ...view(id), imported: r.imported };
}

// ---- 검토 ----
function reviewCondition(id, cid, body) {
  const p = getProject(id);
  const c = p.conditions.find((x) => x.id === cid);
  if (!c) throw new HttpError(404, `조건을 찾을 수 없습니다: ${cid}`);
  const e = body.edits || {};
  if (e.text !== undefined) { if (!s(e.text)) throw new HttpError(400, '조건 문장을 비울 수 없습니다'); c.text = s(e.text).slice(0, 300); }
  if (e.priority !== undefined) { if (!PRIORITIES.includes(e.priority)) throw new HttpError(400, `우선순위는 ${PRIORITIES.join(', ')}`); c.priority = e.priority; }
  if (e.technique !== undefined) { if (!td.TECHNIQUES[e.technique]) throw new HttpError(400, `알 수 없는 기법: ${e.technique}`); c.technique = e.technique; }
  if (e.type !== undefined) { if (!td.TYPES[e.type]) throw new HttpError(400, `알 수 없는 유형: ${e.type}`); c.type = e.type; }
  setReview(c.review, body);
  saveProject(p);
  return view(id);
}

function setReview(r, body) {
  if (body.status) {
    if (!REVIEW.includes(body.status)) throw new HttpError(400, `알 수 없는 검토 상태: ${body.status}`);
    r.status = body.status;
  }
  if (body.note !== undefined) r.note = String(body.note).slice(0, 500);
  r.at = new Date().toISOString();
}

// 여러 조건을 한 번에 (ids가 없으면 검토 대기 전체)
function reviewConditions(id, { status, ids } = {}) {
  const p = getProject(id);
  if (!REVIEW.includes(status)) throw new HttpError(400, `알 수 없는 검토 상태: ${status}`);
  const pick = new Set(arr(ids));
  let n = 0;
  for (const c of p.conditions) {
    if (pick.size ? !pick.has(c.id) : c.review.status !== 'pending') continue;
    setReview(c.review, { status });
    n += 1;
  }
  saveProject(p);
  return { ...view(id), changed: n };
}

function reviewDraft(id, did, body) {
  const p = getProject(id);
  const d = p.drafts.find((x) => x.id === did);
  if (!d) throw new HttpError(404, `초안을 찾을 수 없습니다: ${did}`);
  if (d.appliedAs) throw new HttpError(409, `이미 ${d.appliedAs}로 반영한 초안입니다. TC 편집기에서 고치세요`);
  const e = body.edits || {};
  if (e.title !== undefined) { if (!s(e.title)) throw new HttpError(400, '제목을 비울 수 없습니다'); d.title = s(e.title).slice(0, 120); }
  if (e.priority !== undefined) { if (!PRIORITIES.includes(e.priority)) throw new HttpError(400, `우선순위는 ${PRIORITIES.join(', ')}`); d.priority = e.priority; }
  setReview(d.review, body);
  saveProject(p);
  return view(id);
}

// ---- 반영 ----
function nextIds(prefix, n) {
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`);
  let max = store.listTcs().reduce((m, t) => { const x = t.id.match(re); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return Array.from({ length: n }, () => { max += 1; return `${prefix}${String(max).padStart(3, '0')}`; });
}

function apply(id) {
  const p = getProject(id);
  const todo = p.drafts.filter((d) => d.review.status === 'approved' && !d.appliedAs);
  if (!todo.length) {
    if (p.drafts.some((d) => d.appliedAs)) throw new HttpError(409, '승인한 초안은 이미 반영했습니다');
    throw new HttpError(400, '반영할 초안이 없습니다. ③ TC 초안에서 승인하세요');
  }
  const elements = store.getElements();
  const flows = store.getFlows();
  const schemas = store.getSchemas();
  const out = { tcsAdded: [], elementsAdded: [], manual: [] };
  for (const d of todo) {
    for (const [k, e] of Object.entries(d.newElements || {})) {
      if (e.screen) {
        if (elements.screens[k]) continue;
        elements.screens[k] = { label: e.label, web: null, generatedFrom: p.id };
      } else {
        if (elements.elements[k]) continue;
        elements.elements[k] = { label: e.label, web: null, android: null, ios: null, generatedFrom: p.id };
      }
      out.elementsAdded.push(k);
    }
  }
  const ids = nextIds(p.idPrefix, todo.length);
  const now = new Date().toISOString();
  const saved = [];
  todo.forEach((d, i) => {
    const conds = d.conditionIds.map((c) => p.conditions.find((x) => x.id === c)).filter(Boolean);
    let steps = d.steps;
    let automation = steps.length ? '적합' : '수동 유지';
    const base = {
      id: ids[i], title: d.title, priority: d.priority, tags: ['generated'], platforms: d.platforms, precondition: d.precondition,
      reqIds: [...new Set(conds.flatMap((c) => (c.evidence || []).map((e) => e.policyId)).filter(Boolean))],
      source: { file: `TC 자동 작성 · ${p.name}`, sheet: '', row: null, originalId: d.id, steps: d.source.steps, expected: d.source.expected },
      generated: { project: p.id, draft: d.id, method: d.method, technique: d.technique, conditionIds: d.conditionIds, approvedAt: d.review.at || now, appliedAt: now },
    };
    let tc;
    try {
      tc = validateTc({ ...base, automation, steps, ...(d.dataSets ? { dataSets: d.dataSets } : {}) }, { elements, flows, schemas });
    } catch {
      // 요소 맵이 그사이 바뀌어 스텝이 맞지 않으면 원문만 남긴다
      steps = [];
      automation = '수동 유지';
      tc = validateTc({ ...base, automation, steps }, { elements, flows, schemas });
      out.manual.push(ids[i]);
    }
    saved.push(tc);
    d.appliedAs = tc.id;
    d.review.appliedAt = now;
    out.tcsAdded.push(tc.id);
  });
  if (out.elementsAdded.length) store.saveElements(elements);
  saved.forEach((tc) => store.saveTc(tc));
  saveProject(p);
  return out;
}

// ---- 보기 ----
function coverage(p) {
  const active = p.conditions.filter((c) => c.review.status !== 'rejected');
  const approved = p.conditions.filter((c) => c.review.status === 'approved');
  const policies = p.policies.map((pid) => ({ id: pid, conditions: active.filter((c) => (c.evidence || []).some((e) => e.policyId === pid)).length }));
  const count = (key) => approved.reduce((m, c) => ({ ...m, [c[key]]: (m[c[key]] || 0) + 1 }), {});
  return { policies, uncovered: policies.filter((x) => !x.conditions).map((x) => x.id), techniques: count('technique'), types: count('type') };
}

// 방법별로 QA가 승인한 초안 비율 (AI 초안을 얼마나 그대로 쓰는지)
function stats(p) {
  const by = {};
  for (const d of p.drafts) {
    const m = (by[d.method] = by[d.method] || { total: 0, reviewed: 0, approved: 0, rejected: 0 });
    m.total += 1;
    if (d.review.status !== 'pending') m.reviewed += 1;
    if (d.review.status === 'approved') m.approved += 1;
    if (d.review.status === 'rejected') m.rejected += 1;
  }
  return by;
}

function view(id) {
  const p = getProject(id);
  const elements = store.getElements();
  const flows = store.getFlows();
  const ctx = { elements, flows, schemas: store.getSchemas(), tcs: store.listTcs(), drafts: p.drafts, conditions: p.conditions };
  const form = formState(p, elements, flows);
  const drafts = p.drafts.map((d) => {
    const aug = augmented(elements, d.newElements);
    const line = (x) => (x.action === 'flow' ? `공통 흐름: ${flows[x.target] ? flows[x.target].label : x.target}` : describeStep(x, aug));
    return { ...d, checks: d.appliedAs ? null : checkDraft(d, ctx), lines: d.steps.map(line) };
  });
  const pending = p.drafts.filter((d) => d.review.status === 'approved' && !d.appliedAs).length;
  return {
    ...p, drafts, sections: sections(p), formState: { fields: form.fields.length, errors: form.errors, newElements: form.newElements, ready: form.ready },
    formHeader: td.FORM_HEADER, coverage: coverage(p), stats: stats(p), nextIds: pending ? nextIds(p.idPrefix, pending) : [], prompt: ccPrompt(p.claudeCode),
  };
}

module.exports = {
  listProjects, getProject, createProject, deleteProject, updateProject, addFile, addFigma, removeFile,
  rulesConditions, rulesDrafts, exportForClaudeCode, importClaudeCode, reviewCondition, reviewConditions, reviewDraft, apply, view,
  checkDraft, verifyEvidence, formState, projDir,
};
