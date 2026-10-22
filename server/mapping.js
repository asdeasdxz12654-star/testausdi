// TC 영역 매핑 (기획서 12장).
// 기획서·디자인을 Claude가 읽고 TC마다 화면·요소·영역·근거를 찾는다.
// 확신도는 AI의 자기평가가 아니라 규칙(후보 수, 근거 인용 확인, 디자인 문구 일치)으로 계산하고,
// 기획서에서 찾을 수 없는 인용은 버린다. 반영은 QA가 승인한 결과만 한다.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const store = require('./store');
const { HttpError } = store;
const ai = require('./ai');
const { expandSteps, describeStep } = require('./tc');
const { ACTIONS } = require('./actions');
const { splitLines } = require('./importer');

const DIR = () => path.join(P.STATE, 'mapping');
const projDir = (id) => { store.assertId(id, '매핑 ID'); return path.join(DIR(), id); };
const projFile = (id) => path.join(projDir(id), 'project.json');

let running = null; // 한 번에 하나의 분석만

// ---- 프로젝트 ----
function listProjects() {
  if (!fs.existsSync(DIR())) return [];
  return fs.readdirSync(DIR())
    .filter((d) => fs.existsSync(path.join(DIR(), d, 'project.json')))
    .map((d) => {
      const p = store.readJson(path.join(DIR(), d, 'project.json'));
      return { id: p.id, name: p.name, createdAt: p.createdAt, status: p.status, specs: p.specs.length, frames: p.frames.length, tcs: p.tcIds.length, results: Object.keys(p.results).length };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getProject(id) {
  if (running && running.id === id) return running;
  const f = projFile(id);
  if (!fs.existsSync(f)) throw new HttpError(404, `매핑 프로젝트를 찾을 수 없습니다: ${id}`);
  return store.readJson(f);
}

function saveProject(p) {
  store.writeJson(projFile(p.id), p);
}

function createProject(name) {
  const id = `M${Date.now().toString(36)}`;
  const p = { id, name: String(name || '').trim() || '새 매핑', createdAt: new Date().toISOString(), specs: [], frames: [], figma: null, tcIds: [], status: 'idle', phase: null, progress: null, error: null, inventory: {}, results: {}, usage: null };
  fs.mkdirSync(projDir(id), { recursive: true });
  saveProject(p);
  return p;
}

function deleteProject(id) {
  if (running && running.id === id) throw new HttpError(409, '분석 중인 프로젝트는 지울 수 없습니다');
  fs.rmSync(projDir(id), { recursive: true, force: true });
}

function updateProject(id, patch) {
  const p = getProject(id);
  if (running && running.id === id) throw new HttpError(409, '분석이 끝난 뒤 바꿀 수 있습니다');
  if (patch.name !== undefined) p.name = String(patch.name).trim() || p.name;
  if (Array.isArray(patch.tcIds)) {
    const known = new Set(store.listTcs().map((t) => t.id));
    p.tcIds = patch.tcIds.filter((t) => known.has(t));
  }
  saveProject(p);
  return p;
}

// ---- 자료 ----
const SPEC_KINDS = { '.pdf': 'pdf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.txt': 'text', '.md': 'text' };
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

function nextId(list, prefix) {
  const n = list.reduce((m, x) => Math.max(m, Number(String(x.id).slice(prefix.length)) || 0), 0);
  return `${prefix}${n + 1}`;
}

function addFile(id, { kind, fileName, data }) {
  const p = getProject(id);
  if (running && running.id === id) throw new HttpError(409, '분석이 끝난 뒤 자료를 바꿀 수 있습니다');
  const ext = path.extname(fileName || '').toLowerCase();
  const buf = Buffer.from(data || '', 'base64');
  if (!buf.length) throw new HttpError(400, '빈 파일입니다');
  if (kind === 'spec') {
    if (!SPEC_KINDS[ext]) throw new HttpError(400, '기획서는 PDF, 이미지(PNG/JPG/WEBP), 텍스트(.txt/.md)만 올릴 수 있습니다. PPT·워드는 PDF로 저장해 올려 주세요');
    if (ext === '.pdf' && buf.length > 30 * 1024 * 1024) throw new HttpError(400, 'PDF가 너무 큽니다 (최대 30MB)');
    const sid = nextId(p.specs, 'S');
    const file = `specs/${sid}${ext}`;
    fs.mkdirSync(path.join(projDir(id), 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir(id), file), buf);
    const spec = { id: sid, name: fileName, kind: SPEC_KINDS[ext], file, size: buf.length };
    if (spec.kind === 'text') spec.text = buf.toString('utf8');
    p.specs.push(spec);
  } else if (kind === 'frame') {
    if (!MEDIA[ext] || ext === '.pdf') throw new HttpError(400, '디자인은 프레임을 PNG/JPG/WEBP로 내보내 올려 주세요');
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(400, '이미지가 너무 큽니다 (최대 5MB). 피그마에서 1x로 내보내 주세요');
    const fid = nextId(p.frames, 'F');
    const file = `frames/${fid}${ext}`;
    fs.mkdirSync(path.join(projDir(id), 'frames'), { recursive: true });
    fs.writeFileSync(path.join(projDir(id), file), buf);
    p.frames.push({ id: fid, name: path.basename(fileName, ext), file, source: 'upload', texts: null });
  } else {
    throw new HttpError(400, 'kind는 spec 또는 frame이어야 합니다');
  }
  saveProject(p);
  return p;
}

async function addFigma(id, url, deps = {}) {
  const p = getProject(id);
  const figma = deps.figma || require('./figma');
  const got = await figma.fetchFrames(url, ai.getSettings().figmaToken, deps.figmaOptions);
  fs.mkdirSync(path.join(projDir(id), 'frames'), { recursive: true });
  for (const f of got.frames) {
    const fid = nextId(p.frames, 'F');
    const file = `frames/${fid}.png`;
    fs.writeFileSync(path.join(projDir(id), file), f.png);
    p.frames.push({ id: fid, name: f.name, file, source: 'figma', figmaId: f.figmaId, width: f.width, height: f.height, texts: f.texts });
  }
  p.figma = { url: String(url).trim(), fileKey: got.fileKey };
  saveProject(p);
  return { project: p, added: got.frames.length, skipped: got.skipped };
}

function removeFile(id, fileId) {
  const p = getProject(id);
  if (running && running.id === id) throw new HttpError(409, '분석이 끝난 뒤 자료를 바꿀 수 있습니다');
  const list = fileId.startsWith('S') ? p.specs : p.frames;
  const item = list.find((x) => x.id === fileId);
  if (!item) throw new HttpError(404, `자료를 찾을 수 없습니다: ${fileId}`);
  list.splice(list.indexOf(item), 1);
  fs.rmSync(path.join(projDir(id), item.file), { force: true });
  if (fileId.startsWith('F')) delete p.inventory[fileId];
  saveProject(p);
  return p;
}

// ---- TC → 확인할 문장 목록 ----
function tcLines(tc, elements, flows) {
  // needsElement: 화면 요소를 가리키는 문장인지. 키보드 닫기·뒤로 가기·화면 진입은 영역을 찾지 않아도 된다
  if (tc.steps.length) {
    return expandSteps(tc, flows).map((s) => ({
      no: s.no, text: describeStep(s, elements), kind: s.action.startsWith('assert') ? 'expected' : 'step',
      target: s.target || null, value: s.value, needsElement: ACTIONS[s.action].target === 'element',
    }));
  }
  if (tc.source) {
    const lines = [...splitLines(tc.source.steps).map((t) => ({ text: t, kind: 'step' })), ...splitLines(tc.source.expected).map((t) => ({ text: t, kind: 'expected' }))];
    return lines.map((l, i) => ({ no: i + 1, ...l, target: null, needsElement: !/뒤로\s*가기|키보드|진입|접속|실행/.test(l.text) }));
  }
  return [];
}

// ---- Claude 요청 내용 ----
const SYSTEM = [
  '당신은 QA 엔지니어를 돕는 분석가입니다. 주어진 기획서(spec)와 화면 디자인(frame)만 근거로, 테스트 케이스(TC)가 어느 화면의 어느 영역을 다루는지 찾습니다.',
  '규칙:',
  '- 자료에서 확인할 수 없는 내용은 추측하지 않습니다. 확인할 수 없으면 문자열은 "", 숫자는 -1로 두고 note나 notes에 이유를 적습니다.',
  '- frame과 doc에는 자료에 붙은 id(F1, S1 ...)만 씁니다.',
  '- box는 해당 프레임 이미지 기준 [x, y, 너비, 높이]이며 각 값은 0~1 비율입니다. 요소를 찾지 못했으면 빈 배열입니다.',
  '- candidates는 그 문장이 가리킬 수 있는 요소가 화면에 몇 개인지입니다. 하나로 정해지면 1, 문구가 모호해 여러 개면 그 개수, 찾지 못하면 0입니다.',
  '- designTextMatch는 문장에 나온 문구(따옴표 안 내용, 버튼 이름 등)가 디자인 화면의 글자와 같을 때만 true입니다.',
  '- evidence.quote는 기획서 문장을 글자 그대로 옮깁니다. 요약하거나 고쳐 쓰지 않습니다. policyId는 기획서에 정책 번호가 있을 때만 씁니다. page는 PDF 쪽 번호, 없으면 -1입니다.',
  '- TC가 필요로 하는 화면 상태(에러, 로딩, 빈 화면, 팝업 등)가 디자인에 없으면 missingInDesign에 적습니다.',
  '- TC의 동작이 기획서 어디에도 근거가 없으면 specGap을 true로 둡니다.',
  '- elementKey는 요소 맵에 같은 요소가 있을 때만 그 이름을 씁니다. 없으면 suggestedKey에 "화면.요소" 형식의 영문 camelCase 이름을 제안합니다 (예: login.findPassword).',
].join('\n');

const str = { type: 'string' };
const MAPPING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['frame', 'steps', 'evidence', 'missingInDesign', 'specGap', 'notes'],
  properties: {
    frame: str,
    steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['lineNo', 'frame', 'name', 'elementKey', 'suggestedKey', 'box', 'candidates', 'designTextMatch', 'note'],
        properties: { lineNo: { type: 'integer' }, frame: str, name: str, elementKey: str, suggestedKey: str, box: { type: 'array', items: { type: 'number' } }, candidates: { type: 'integer' }, designTextMatch: { type: 'boolean' }, note: str },
      },
    },
    evidence: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['doc', 'policyId', 'quote', 'page'], properties: { doc: str, policyId: str, quote: str, page: { type: 'integer' } } },
    },
    missingInDesign: { type: 'array', items: str },
    specGap: { type: 'boolean' },
    notes: str,
  },
};

const INVENTORY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['elements'],
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'kind', 'text', 'box'],
        properties: { name: str, kind: { type: 'string', enum: ['button', 'input', 'link', 'tab', 'text', 'image', 'other'] }, text: str, box: { type: 'array', items: { type: 'number' } } },
      },
    },
  },
};

// 모든 요청이 같은 자료 묶음으로 시작하므로 마지막 자료 블록에 캐시 표시를 둔다 (TC가 많아도 자료 비용은 한 번)
function sharedContent(p, elements) {
  const blocks = [{ type: 'text', text: '아래는 테스트 대상 앱의 화면 디자인과 기획서입니다.' }];
  for (const f of p.frames) {
    const buf = fs.readFileSync(path.join(projDir(p.id), f.file));
    const texts = f.texts && f.texts.length ? `\n피그마 텍스트 레이어(문구와 [x,y,너비,높이] 비율):\n${JSON.stringify(f.texts.map((t) => [t.text, t.box]))}` : '';
    blocks.push({ type: 'text', text: `<frame id="${f.id}" name="${f.name}">${texts}` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: MEDIA[path.extname(f.file)], data: buf.toString('base64') } });
  }
  for (const s of p.specs) {
    blocks.push({ type: 'text', text: `<spec id="${s.id}" name="${s.name}">` });
    if (s.kind === 'text') blocks.push({ type: 'text', text: s.text });
    else {
      const buf = fs.readFileSync(path.join(projDir(p.id), s.file));
      blocks.push(s.kind === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: MEDIA[path.extname(s.file)], data: buf.toString('base64') } });
    }
  }
  const elLines = Object.entries(elements.elements).map(([k, e]) => `${k}: ${e.label}`);
  const scLines = Object.entries(elements.screens).map(([k, s]) => `${k}: ${s.label}`);
  blocks.push({ type: 'text', text: `요소 맵 (논리 이름: 표시 이름)\n화면:\n${scLines.join('\n')}\n요소:\n${elLines.join('\n')}`, cache_control: { type: 'ephemeral' } });
  return blocks;
}

function tcPrompt(tc, lines) {
  return [
    `TC ${tc.id} "${tc.title}" 를 분석하세요.`,
    `우선순위 ${tc.priority} · 플랫폼 ${tc.platforms.join(', ')}${tc.precondition ? ` · 사전조건: ${tc.precondition}` : ''}`,
    '확인할 문장 (lineNo. 종류: 문장):',
    ...lines.map((l) => `${l.no}. ${l.kind === 'expected' ? '기대결과' : '절차'}: ${l.text}`),
    '',
    'frame에는 이 TC의 주 화면을, steps에는 문장마다 하나씩(lineNo 순서대로) 대상 요소를, evidence에는 근거가 되는 기획서 문장을 적으세요.',
  ].join('\n');
}

// ---- 검증·확신도 ----
const normText = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && v >= 0 && v <= 1.0001) && b[2] > 0 && b[3] > 0;
const KEY_RE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

function verifyResult(raw, { p, lines, elements }) {
  const frames = new Set(p.frames.map((f) => f.id));
  const specs = Object.fromEntries(p.specs.map((s) => [s.id, s]));
  const warnings = [];
  const frame = frames.has(raw.frame) ? raw.frame : '';
  if (raw.frame && !frame) warnings.push(`없는 화면 id(${raw.frame})를 답해 버렸습니다`);

  const steps = lines.map((l) => {
    const s = raw.steps.find((x) => x.lineNo === l.no) || null;
    const out = { lineNo: l.no, text: l.text, kind: l.kind, needsElement: l.needsElement !== false, frame: '', name: '', elementKey: '', suggestedKey: '', box: null, candidates: 0, designTextMatch: null, textCheck: 'ai', note: '' };
    if (!s) { out.note = '분석 결과가 없습니다'; return out; }
    out.frame = frames.has(s.frame) ? s.frame : frame;
    out.name = s.name || '';
    out.elementKey = elements.elements[s.elementKey] ? s.elementKey : '';
    if (s.elementKey && !out.elementKey) warnings.push(`${l.no}번: 요소 맵에 없는 이름(${s.elementKey})을 답해 버렸습니다`);
    out.suggestedKey = !out.elementKey && KEY_RE.test(s.suggestedKey || '') ? s.suggestedKey : '';
    out.box = validBox(s.box) ? s.box.map((v) => Math.round(v * 1000) / 1000) : null;
    out.candidates = Number.isInteger(s.candidates) && s.candidates >= 0 ? s.candidates : 0;
    out.designTextMatch = !!s.designTextMatch;
    out.note = s.note || '';
    // 피그마 텍스트 레이어가 있으면 따옴표 안 문구가 디자인에 실제로 있는지 직접 확인한다
    const quotedVal = (l.text.match(/"([^"]+)"/) || [])[1];
    const fr = p.frames.find((f) => f.id === out.frame);
    if (quotedVal && fr && fr.texts && !/테스트 데이터/.test(quotedVal)) {
      out.designTextMatch = fr.texts.some((t) => normText(t.text).includes(normText(quotedVal)));
      out.textCheck = 'figma';
    }
    return out;
  });

  // 인용 확인: 텍스트 기획서는 원문에서 직접 찾고, 못 찾으면 버린다. PDF·이미지는 확인할 수 없음으로 표시
  const evidence = [];
  for (const e of raw.evidence || []) {
    const spec = specs[e.doc];
    if (!spec || !e.quote) { warnings.push(`근거 문서 id(${e.doc})가 올바르지 않아 버렸습니다`); continue; }
    if (spec.kind === 'text') {
      if (!normText(spec.text).includes(normText(e.quote))) { warnings.push(`기획서 ${spec.name}에서 찾을 수 없는 인용을 버렸습니다: "${e.quote.slice(0, 40)}"`); continue; }
      evidence.push({ ...e, specName: spec.name, verified: true });
    } else {
      evidence.push({ ...e, specName: spec.name, verified: null });
    }
  }
  return { frame, steps, evidence, missingInDesign: (raw.missingInDesign || []).filter(Boolean), specGap: !!raw.specGap, notes: raw.notes || '', warnings };
}

// 기획서 12장의 확신도 기준
function confidence(r) {
  const reasons = [];
  const targets = r.steps.filter((s) => s.needsElement !== false);
  const located = targets.filter((s) => s.box);
  const maxCand = Math.max(0, ...r.steps.map((s) => s.candidates));
  const mismatch = r.steps.filter((s) => s.designTextMatch === false && /"/.test(s.text));
  const hasEvidence = r.evidence.length > 0;
  if (!r.frame && !hasEvidence) return { level: 'none', reasons: ['디자인 화면과 기획서 근거를 모두 찾지 못했습니다 (기획 누락 의심)'] };
  if (maxCand >= 3) reasons.push(`후보가 ${maxCand}개인 문장이 있습니다`);
  if (mismatch.length) reasons.push(`문구가 디자인과 다른 문장 ${mismatch.length}개`);
  if (maxCand >= 3 || mismatch.length) return { level: 'low', reasons };
  if (!r.frame) reasons.push('주 화면을 찾지 못했습니다');
  if (!hasEvidence) reasons.push('기획서 근거가 없습니다');
  if (maxCand === 2) reasons.push('후보가 2개인 문장이 있습니다');
  if (located.length < targets.length) reasons.push(`영역을 찾지 못한 문장 ${targets.length - located.length}개`);
  if (r.missingInDesign.length) reasons.push(`디자인에 없는 상태: ${r.missingInDesign.join(', ')}`);
  if (reasons.length) return { level: 'mid', reasons };
  const unverified = r.evidence.every((e) => e.verified !== true);
  return { level: 'high', reasons: [`요소 후보 1개, 디자인과 기획서 근거 모두 있음${unverified ? ' (PDF·이미지 근거는 원문 대조 불가)' : ''}`] };
}

// ---- 분석 실행 ----
function estimate(p, tcCount) {
  const imageTokens = 1600;
  let shared = 400 + p.frames.length * (imageTokens + 150);
  for (const s of p.specs) shared += s.kind === 'text' ? Math.ceil(s.text.length / 1.5) : s.kind === 'image' ? imageTokens : Math.ceil(s.size / 60);
  const invCalls = p.frames.filter((f) => !p.inventory[f.id]).length;
  const calls = invCalls + tcCount;
  if (!calls) return { calls: 0, sharedTokens: shared, usd: 0 };
  const t = { input: calls * 600, output: invCalls * 1500 + tcCount * 2500, cacheWrite: shared, cacheRead: shared * (calls - 1), calls };
  return { calls, sharedTokens: shared, usd: Math.round(ai.costUsd(t) * 100) / 100 };
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const item = items[i]; i += 1; await fn(item); }
  });
  await Promise.all(workers);
}

function startAnalysis(id, { tcIds, onlyNew } = {}, deps = {}) {
  if (running) throw new HttpError(409, `다른 분석이 진행 중입니다 (${running.name})`);
  const p = getProject(id);
  const settings = ai.getSettings();
  if (!settings.consent) throw new HttpError(400, '외부 AI 전송 동의가 필요합니다. 설정에서 기획서·디자인을 Claude API로 보내는 것에 동의해 주세요');
  if (!p.frames.length) throw new HttpError(400, '디자인 화면(캡처 또는 피그마)을 하나 이상 넣어 주세요');
  const ids = (tcIds && tcIds.length ? tcIds : p.tcIds).filter((t) => !onlyNew || !p.results[t]);
  const tcs = store.listTcs().filter((t) => ids.includes(t.id));
  if (!tcs.length) throw new HttpError(400, '분석할 TC를 고르세요');
  const client = deps.client || ai.makeClient(settings.apiKey);
  const config = store.getConfig();
  const model = (config.ai && config.ai.model) || 'claude-opus-5-5';
  const effort = (config.ai && config.ai.effort) || 'high';
  const elements = store.getElements();
  const flows = store.getFlows();

  p.status = 'running';
  p.error = null;
  p.phase = '화면 요소 파악';
  p.progress = { done: 0, total: p.frames.filter((f) => !p.inventory[f.id]).length + tcs.length };
  p.lastRun = { at: new Date().toISOString(), model, errors: [] };
  running = p;
  saveProject(p);

  const shared = sharedContent(p, elements);
  const call = async (text, schema) => {
    const r = await ai.callJson(client, { model, effort, system: SYSTEM, content: [...shared, { type: 'text', text }], schema });
    p.usage = ai.addUsage(p.usage, r.usage);
    return r.data;
  };

  const job = (async () => {
    // 첫 요청이 캐시를 만든 뒤 나머지를 병렬로 보낸다
    const invTodo = p.frames.filter((f) => !p.inventory[f.id]);
    const tasks = [
      ...invTodo.map((f) => async () => {
        const d = await call(`프레임 ${f.id}("${f.name}")에 보이는 UI 요소(버튼, 입력창, 링크, 탭, 안내 문구 등)를 빠짐없이 나열하세요. box는 이 프레임 기준 비율입니다.`, INVENTORY_SCHEMA);
        p.inventory[f.id] = d.elements.filter((e) => validBox(e.box)).map((e, i) => ({ id: `${f.id}-e${i + 1}`, ...e }));
      }),
      ...tcs.map((tc) => async () => {
        p.phase = 'TC 분석';
        const lines = tcLines(tc, elements, flows);
        if (!lines.length) { p.lastRun.errors.push(`${tc.id}: 스텝과 원문이 없어 건너뜀`); return; }
        const raw = await call(tcPrompt(tc, lines), MAPPING_SCHEMA);
        const v = verifyResult(raw, { p, lines, elements });
        const prev = p.results[tc.id];
        p.results[tc.id] = { tcId: tc.id, title: tc.title, ...v, confidence: confidence(v), analyzedAt: new Date().toISOString(), review: { status: 'pending', note: prev && prev.review ? prev.review.note : '' } };
      }),
    ];
    const runTask = async (t) => {
      try { await t(); } catch (e) {
        p.lastRun.errors.push(e.message);
        if (e.status === 401 || e.status === 400) throw e; // 키·요청 형식 문제는 계속해도 같은 결과
      } finally { p.progress.done += 1; }
    };
    if (tasks.length) await runTask(tasks[0]);
    await pool(tasks.slice(1), 3, runTask);
  })();

  job.then(() => {
    p.status = p.lastRun.errors.length && !Object.keys(p.results).length ? 'error' : 'done';
    if (p.status === 'error') p.error = p.lastRun.errors[0];
  }).catch((e) => {
    p.status = 'error';
    p.error = e.message;
  }).finally(() => {
    p.phase = null;
    running = null;
    saveProject(p);
    if (deps.onDone) deps.onDone(p);
  });
  return p;
}

// ---- 커버리지 (TC 없는 영역, 근거 없는 TC) ----
const INTERACTIVE = new Set(['button', 'input', 'link', 'tab']);
// 겹치는 면적 비율(IoU). 큰 영역 안에 든 작은 요소(에러 문구 안 닫기 버튼 등)를 "다뤄짐"으로 보지 않도록 0.3 이상만 인정한다
const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};

function coverage(p) {
  // "화면 진입"처럼 화면 전체를 가리키는 영역(면적 25% 이상)은 특정 요소를 다룬 것으로 보지 않는다
  const used = Object.values(p.results)
    .filter((r) => r.review.status !== 'rejected')
    .flatMap((r) => r.steps.filter((s) => s.box && s.frame && s.box[2] * s.box[3] < 0.25));
  const uncovered = [];
  for (const f of p.frames) {
    for (const e of p.inventory[f.id] || []) {
      if (!INTERACTIVE.has(e.kind)) continue;
      const hit = used.some((s) => s.frame === f.id && (iou(s.box, e.box) >= 0.3 || (s.name && normText(s.name) === normText(e.name))));
      if (!hit) uncovered.push({ frame: f.id, frameName: f.name, ...e });
    }
  }
  const noEvidence = Object.values(p.results).filter((r) => !r.evidence.length || r.specGap).map((r) => r.tcId);
  const missingStates = Object.values(p.results).filter((r) => r.missingInDesign.length).map((r) => ({ tcId: r.tcId, states: r.missingInDesign }));
  return { uncovered, noEvidence, missingStates };
}

// 확신도 등급별로 QA가 그대로 승인한 비율 (기획서 12장 "높음 정확도" 지표)
function stats(p) {
  const by = {};
  for (const r of Object.values(p.results)) {
    const l = r.confidence.level;
    by[l] = by[l] || { total: 0, reviewed: 0, approvedAsIs: 0 };
    by[l].total += 1;
    if (r.review.status !== 'pending') by[l].reviewed += 1;
    if (r.review.status === 'approved') by[l].approvedAsIs += 1;
  }
  return by;
}

function view(id) {
  const p = getProject(id);
  return { ...p, coverage: coverage(p), stats: stats(p), estimate: estimate(p, p.tcIds.filter((t) => !p.results[t]).length), estimateAll: estimate(p, p.tcIds.length), usd: Math.round(ai.costUsd(p.usage) * 100) / 100 };
}

// ---- 검토 ----
const REVIEW = ['pending', 'approved', 'edited', 'inquiry', 'rejected'];

function review(id, tcId, body) {
  const p = getProject(id);
  if (running && running.id === id) throw new HttpError(409, '분석이 끝난 뒤 검토할 수 있습니다');
  const r = p.results[tcId];
  if (!r) throw new HttpError(404, `분석 결과가 없습니다: ${tcId}`);
  const elements = store.getElements();
  for (const ed of body.edits || []) {
    const s = r.steps.find((x) => x.lineNo === ed.lineNo);
    if (!s) continue;
    if (ed.elementKey !== undefined) {
      if (ed.elementKey && !elements.elements[ed.elementKey]) throw new HttpError(400, `요소 맵에 없는 요소: ${ed.elementKey}`);
      s.elementKey = ed.elementKey;
      if (ed.elementKey) s.suggestedKey = '';
    }
    if (ed.suggestedKey !== undefined) {
      if (ed.suggestedKey && !KEY_RE.test(ed.suggestedKey)) throw new HttpError(400, `요소 이름은 화면.요소 형식이어야 합니다: ${ed.suggestedKey}`);
      s.suggestedKey = ed.suggestedKey;
      if (ed.suggestedKey) s.elementKey = '';
    }
    if (ed.name !== undefined) s.name = String(ed.name);
  }
  if (body.status) {
    if (!REVIEW.includes(body.status)) throw new HttpError(400, `알 수 없는 검토 상태: ${body.status}`);
    r.review.status = body.status === 'approved' && (body.edits || []).length ? 'edited' : body.status;
  }
  if (body.note !== undefined) r.review.note = String(body.note);
  r.review.at = new Date().toISOString();
  saveProject(p);
  return view(id);
}

// ---- 반영: 승인한 결과만 요소 맵과 TC에 ----
function apply(id) {
  const p = getProject(id);
  if (running && running.id === id) throw new HttpError(409, '분석이 끝난 뒤 반영할 수 있습니다');
  const elements = store.getElements();
  const out = { elementsAdded: [], tcsUpdated: [], skipped: [] };
  const approved = Object.values(p.results).filter((r) => r.review.status === 'approved' || r.review.status === 'edited');
  for (const r of approved) {
    for (const s of r.steps) {
      if (s.elementKey || !s.suggestedKey || !s.name) continue;
      if (elements.elements[s.suggestedKey]) { s.elementKey = s.suggestedKey; continue; }
      elements.elements[s.suggestedKey] = { label: s.name, web: null, android: null, ios: null, mappedFrom: { project: p.id, frame: (p.frames.find((f) => f.id === s.frame) || {}).name || '', box: s.box } };
      out.elementsAdded.push(s.suggestedKey);
      s.elementKey = s.suggestedKey;
    }
    let tc;
    try { tc = store.getTc(r.tcId); } catch { out.skipped.push({ id: r.tcId, reason: 'TC가 삭제되었습니다' }); continue; }
    const policyIds = r.evidence.map((e) => e.policyId).filter(Boolean);
    tc.reqIds = [...new Set([...(tc.reqIds || []), ...policyIds])];
    const fr = p.frames.find((f) => f.id === r.frame);
    tc.mapping = { project: p.id, frame: fr ? fr.name : '', approvedAt: new Date().toISOString(), elements: r.steps.filter((s) => s.elementKey).map((s) => s.elementKey) };
    store.saveTc(tc);
    out.tcsUpdated.push(tc.id);
    r.review.appliedAt = new Date().toISOString();
  }
  if (out.elementsAdded.length) store.saveElements(elements);
  saveProject(p);
  return out;
}

module.exports = {
  listProjects, getProject, createProject, deleteProject, updateProject, addFile, addFigma, removeFile,
  startAnalysis, view, review, apply, estimate,
  tcLines, verifyResult, confidence, coverage, MAPPING_SCHEMA, INVENTORY_SCHEMA, SYSTEM, projDir,
};
