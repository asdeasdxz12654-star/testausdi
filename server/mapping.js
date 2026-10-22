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
    p.frames.push({ id: fid, name: f.name, file, source: 'figma', figmaId: f.figmaId, width: f.width, height: f.height, texts: f.texts, nodes: f.nodes || [] });
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
  '- designTextMatch는 기대결과 문장의 문구(따옴표 안 내용)가 디자인 화면의 글자와 같을 때만 true입니다. 절차 문장의 따옴표는 입력값이므로 비교하지 않고, 대상 요소가 화면에 보이면 true로 둡니다.',
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
    if (l.kind === 'expected' && quotedVal && fr && fr.texts && !/테스트 데이터/.test(quotedVal)) {
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
  // 문구 비교는 기대결과 문장만. 절차 문장의 따옴표는 입력값이라 화면에 없는 게 정상이다
  const mismatch = r.steps.filter((s) => s.kind === 'expected' && s.designTextMatch === false && /"/.test(s.text));
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

// method: rules(규칙, 무료) / claude-code(구독) / api(유료)
function storeResult(p, tc, v, method) {
  const prev = p.results[tc.id];
  p.results[tc.id] = {
    tcId: tc.id, title: tc.title, ...v, method, confidence: confidence(v), analyzedAt: new Date().toISOString(),
    review: { status: 'pending', note: prev && prev.review ? prev.review.note : '' },
  };
}

function pickTcs(p, { tcIds, onlyNew } = {}) {
  const ids = (tcIds && tcIds.length ? tcIds : p.tcIds).filter((t) => !onlyNew || !p.results[t]);
  const tcs = store.listTcs().filter((t) => ids.includes(t.id));
  if (!tcs.length) throw new HttpError(400, '분석할 TC를 고르세요');
  return tcs;
}

// ---- 규칙 기반 분석 (AI 없음, 무료) ----
// 피그마 텍스트 레이어·버튼 레이어와 텍스트 기획서만으로 찾는다. 캡처 이미지만 있는 화면은 위치를 찾을 수 없다
const STRIP = /(입력\s*창|입력\s*란|입력\s*필드|입력\s*칸|필드|버튼|문구|텍스트|영역|아이콘|링크|탭|메뉴|칸)$/;
const STOP = new Set(['화면', '진입', '입력', '클릭', '노출', '확인', '선택', '버튼', '문구', '테스트', '데이터', '미노출', '표시', '이동', '경우', '상태', '시']);
const quotedIn = (t) => [...String(t).matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((q) => !/^테스트 데이터/.test(q));
const center = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const inside = (pt, b) => pt[0] >= b[0] && pt[0] <= b[0] + b[2] && pt[1] >= b[1] && pt[1] <= b[1] + b[3];

// 한 문장이 한 프레임에서 가리키는 레이어 후보
function ruleHits(f, line, elements) {
  const texts = f.texts || [];
  const nodes = f.nodes || [];
  const values = quotedIn(line.text);
  const names = [];
  const el = line.target && elements.elements[line.target];
  if (el) {
    names.push(el.label);
    const short = el.label.replace(STRIP, '').trim();
    if (short.length >= 2) names.push(short);
  }
  const hits = [];
  // 1) 따옴표 안 문구: 그 문구를 담은 텍스트 레이어
  for (const v of values) texts.filter((t) => normText(t.text).includes(normText(v))).forEach((t) => hits.push({ name: t.text, box: t.box, via: 'value' }));
  // 2) 요소 이름: 이름이 같은 버튼·입력창 레이어, 또는 글자가 같은 텍스트 레이어
  if (!hits.length) {
    for (const n of names) {
      nodes.filter((x) => normText(x.name) === normText(n) || (x.text && normText(x.text) === normText(n))).forEach((x) => hits.push({ name: x.text || x.name, box: x.box, via: 'node' }));
      if (!hits.length) texts.filter((t) => normText(t.text) === normText(n)).forEach((t) => hits.push({ name: t.text, box: t.box, via: 'text' }));
      if (hits.length) break;
    }
  }
  // 3) 원문만 있는 TC: 문장 안에 들어 있는 레이어 글자 (가장 긴 것)
  if (!hits.length && !el) {
    const inLine = texts.filter((t) => normText(t.text).length >= 2 && normText(line.text).includes(normText(t.text)));
    const longest = Math.max(0, ...inLine.map((t) => normText(t.text).length));
    inLine.filter((t) => normText(t.text).length === longest).forEach((t) => hits.push({ name: t.text, box: t.box, via: 'text' }));
  }
  // 글자 레이어가 버튼·입력창 레이어 안에 있으면 그 레이어 영역을 쓴다 (TC 없는 영역 계산이 맞도록)
  return hits.map((h) => {
    const host = h.via !== 'node' && nodes.find((n) => inside(center(h.box), n.box));
    return host ? { ...h, box: host.box, name: host.text || host.name } : h;
  });
}

// 기획서 문장 점수: TC의 따옴표 문구가 그대로 있으면 3점, 요소 이름·제목 낱말이 있으면 1점씩. 2점 이상인 문장 중 상위 2개
function ruleEvidence(p, tc, lines, elements) {
  const values = new Set(lines.flatMap((l) => quotedIn(l.text)));
  const words = new Set();
  lines.forEach((l) => {
    const el = l.target && elements.elements[l.target];
    if (el) words.add(el.label.replace(STRIP, '').trim());
  });
  String(tc.title).split(/[\s,·/()]+/)
    .map((w) => w.replace(/(을|를|이|가|은|는|에|의|시)$/, ''))
    .filter((w) => /[가-힣A-Za-z]{2,}/.test(w) && !STOP.has(w))
    .forEach((w) => words.add(w));
  const out = [];
  for (const s of p.specs.filter((x) => x.kind === 'text')) {
    const sentences = s.text.split(/\r?\n|(?<=[.!?。])\s+/).map((x) => x.trim()).filter((x) => x.length >= 4);
    const scored = sentences.map((line) => {
      const n = normText(line);
      let score = 0;
      values.forEach((v) => { if (n.includes(normText(v))) score += 3; });
      words.forEach((w) => { if (w.length >= 2 && n.includes(normText(w))) score += 1; });
      return { line, score };
    }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 2);
    scored.forEach((x) => out.push({ doc: s.id, specName: s.name, policyId: (x.line.match(/\b[A-Z]{2,6}-\d{1,4}\b/) || [''])[0], quote: x.line, page: -1, verified: true }));
  }
  return out;
}

function ruleMapTc(p, tc, lines, elements) {
  const frames = p.frames.filter((f) => (f.texts && f.texts.length) || (f.nodes && f.nodes.length));
  const perFrame = frames.map((f) => ({ f, hits: lines.map((l) => ruleHits(f, l, elements)) }));
  const screenLabel = (lines.find((l) => l.target && elements.screens[l.target]) || {}).target;
  const label = screenLabel ? normText(elements.screens[screenLabel].label) : '';
  const score = (x) => x.hits.filter((h) => h.length).length + (label && normText(x.f.name).includes(label) ? 0.5 : 0);
  const best = perFrame.slice().sort((a, b) => score(b) - score(a))[0];
  const main = best && score(best) >= 1 ? best : null;
  const warnings = [];
  if (!frames.length) warnings.push('피그마 텍스트 레이어가 있는 화면이 없어 위치를 찾지 못했습니다. 규칙 기반 분석은 피그마에서 가져온 화면에서만 동작합니다');

  const steps = lines.map((l, i) => {
    const base = { lineNo: l.no, text: l.text, kind: l.kind, needsElement: l.needsElement !== false, frame: '', name: '', elementKey: l.target && elements.elements[l.target] ? l.target : '', suggestedKey: '', box: null, candidates: 0, designTextMatch: null, textCheck: 'figma', note: '' };
    if (l.target && elements.screens[l.target]) {
      // 화면 진입은 화면 전체가 대상. 주 화면을 못 찾았으면 화면 안 글자에 억지로 맞추지 않는다
      return main ? { ...base, frame: main.f.id, name: elements.screens[l.target].label, box: [0, 0, 1, 1], candidates: 1, designTextMatch: true } : { ...base, note: '화면을 찾지 못했습니다' };
    }
    // 주 화면에서 먼저 찾고, 없으면 다른 화면에서 찾는다
    const where = (main && main.hits[i].length ? main : perFrame.find((x) => x.hits[i].length)) || null;
    const values = quotedIn(l.text);
    if (!where) {
      const expectedText = values.length && l.kind === 'expected';
      return { ...base, designTextMatch: expectedText ? false : null, note: expectedText ? `"${values[0]}" 문구가 있는 화면을 찾지 못했습니다` : '이름이 같은 레이어를 찾지 못했습니다' };
    }
    const h = where.hits[i];
    return { ...base, frame: where.f.id, name: h[0].name, box: h[0].box, candidates: h.length, designTextMatch: values.length && l.kind === 'expected' ? values.every((v) => (where.f.texts || []).some((t) => normText(t.text).includes(normText(v)))) : true };
  });
  const evidence = ruleEvidence(p, tc, lines, elements);
  if (p.specs.some((s) => s.kind !== 'text')) warnings.push('PDF·이미지 기획서는 규칙 기반 분석에서 근거를 찾을 수 없습니다. 텍스트(.txt/.md)로 저장해 올리면 찾습니다');
  const missingInDesign = [...new Set(steps.filter((s) => s.designTextMatch === false).flatMap((s) => quotedIn(s.text).map((q) => `"${q}" 문구가 있는 화면`)))];
  return { frame: main ? main.f.id : '', steps, evidence, missingInDesign, specGap: !evidence.length, notes: '', warnings };
}

function analyzeRules(id, opts = {}) {
  if (running && running.id === id) throw new HttpError(409, '분석 중입니다');
  const p = getProject(id);
  const tcs = pickTcs(p, opts);
  const elements = store.getElements();
  const flows = store.getFlows();
  // 피그마 레이어로 요소 목록을 만들어 둔다 (AI 분석으로 이미 만든 목록은 그대로 둔다)
  p.frames.forEach((f) => { if (!p.inventory[f.id] && f.nodes && f.nodes.length) p.inventory[f.id] = f.nodes.map((n, i) => ({ id: `${f.id}-n${i + 1}`, name: n.text || n.name, kind: n.kind, text: n.text, box: n.box })); });
  const skipped = [];
  for (const tc of tcs) {
    const lines = tcLines(tc, elements, flows);
    if (!lines.length) { skipped.push(`${tc.id}: 스텝과 원문이 없어 건너뜀`); continue; }
    storeResult(p, tc, ruleMapTc(p, tc, lines, elements), 'rules');
  }
  p.lastRun = { at: new Date().toISOString(), model: 'rules', errors: skipped };
  saveProject(p);
  return view(id);
}

// ---- Claude Code 연계 (구독 안에서 처리) ----
// 요청 파일을 만들고, Claude Code가 쓴 응답 파일을 API 답과 같은 규칙으로 검증해 가져온다
const ccDir = (id) => path.join(projDir(id), 'claude-code');

function exportForClaudeCode(id, opts = {}) {
  const p = getProject(id);
  if (!p.frames.length) throw new HttpError(400, '디자인 화면(캡처 또는 피그마)을 하나 이상 넣어 주세요');
  const tcs = pickTcs(p, opts);
  const elements = store.getElements();
  const flows = store.getFlows();
  const dir = ccDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const abs = (f) => path.join(projDir(id), f);
  const responseFile = path.join(dir, 'response.json');
  const tcBlocks = tcs.map((tc) => {
    const lines = tcLines(tc, elements, flows);
    return lines.length ? tcPrompt(tc, lines) : null;
  }).filter(Boolean);
  const md = [
    `# AutoTC 영역 매핑 요청 · ${p.name}`,
    '',
    '이 파일은 AutoTC가 만든 분석 요청입니다. 아래 자료를 직접 읽고, 맨 아래 형식대로 결과 파일을 써 주세요.',
    '',
    '## 분석 규칙',
    SYSTEM,
    '',
    '## 화면 디자인 (이미지 파일을 열어서 보세요)',
    ...p.frames.map((f) => `- ${f.id} "${f.name}": ${abs(f.file)}${f.texts && f.texts.length ? `\n  피그마 텍스트 레이어(문구와 [x,y,너비,높이] 비율): ${JSON.stringify(f.texts.map((t) => [t.text, t.box]))}` : ''}`),
    '',
    '## 기획서',
    ...(p.specs.length ? p.specs.map((s) => `- ${s.id} "${s.name}": ${abs(s.file)}`) : ['- (없음)']),
    '',
    '## 요소 맵 (논리 이름: 표시 이름)',
    ...Object.entries(elements.screens).map(([k, s]) => `- 화면 ${k}: ${s.label}`),
    ...Object.entries(elements.elements).map(([k, e]) => `- ${k}: ${e.label}`),
    '',
    '## 분석할 TC',
    ...tcBlocks.map((b) => `\n${b}`),
    '',
    '## 결과 파일',
    `다음 경로에 JSON으로 저장하세요: ${responseFile}`,
    '',
    '```',
    '{',
    '  "inventory": { "<프레임 id>": [ { "name": "", "kind": "button|input|link|tab|text|image|other", "text": "", "box": [x, y, w, h] } ] },',
    '  "results": { "<TC ID>": { "frame": "", "steps": [ { "lineNo": 1, "frame": "", "name": "", "elementKey": "", "suggestedKey": "", "box": [x, y, w, h], "candidates": 1, "designTextMatch": true, "note": "" } ], "evidence": [ { "doc": "S1", "policyId": "", "quote": "", "page": -1 } ], "missingInDesign": [], "specGap": false, "notes": "" } }',
    '}',
    '```',
    '- inventory에는 각 프레임에 보이는 버튼·입력창·링크·탭·안내 문구를 빠짐없이 적습니다 (box는 그 프레임 기준 0~1 비율).',
    '- results에는 위 TC를 하나도 빠짐없이 적고, steps는 TC의 문장마다 하나씩 lineNo 순서대로 적습니다.',
    '- 확인할 수 없는 값은 지어내지 말고 "" 또는 -1, box는 []로 둡니다. 확신도는 AutoTC가 규칙으로 계산하므로 적지 않습니다.',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'request.md'), md, 'utf8');
  if (fs.existsSync(responseFile)) fs.renameSync(responseFile, path.join(dir, `response-${Date.now()}.json.bak`));
  p.claudeCode = { requestFile: path.join(dir, 'request.md'), responseFile, tcIds: tcs.map((t) => t.id), at: new Date().toISOString() };
  saveProject(p);
  return {
    ...view(id),
    prompt: `${p.claudeCode.requestFile} 파일을 읽고, 안의 지시대로 화면·기획서를 분석해서 ${responseFile} 에 결과를 저장해 줘.`,
  };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const strOr = (v) => (typeof v === 'string' ? v : '');

// 응답 파일의 모양을 API 스키마와 같게 맞춘다. 빠진 칸은 비우고, 형식이 틀린 칸은 버린다
function normalizeRaw(r) {
  return {
    frame: strOr(r.frame),
    steps: arr(r.steps).filter((s) => s && Number.isInteger(s.lineNo)).map((s) => ({
      lineNo: s.lineNo, frame: strOr(s.frame), name: strOr(s.name), elementKey: strOr(s.elementKey), suggestedKey: strOr(s.suggestedKey),
      box: arr(s.box), candidates: Number.isInteger(s.candidates) ? s.candidates : 0, designTextMatch: !!s.designTextMatch, note: strOr(s.note),
    })),
    evidence: arr(r.evidence).filter((e) => e && typeof e.quote === 'string').map((e) => ({ doc: strOr(e.doc), policyId: strOr(e.policyId), quote: e.quote, page: Number.isInteger(e.page) ? e.page : -1 })),
    missingInDesign: arr(r.missingInDesign).filter((x) => typeof x === 'string'),
    specGap: !!r.specGap,
    notes: strOr(r.notes),
  };
}

function importClaudeCode(id) {
  if (running && running.id === id) throw new HttpError(409, '분석 중입니다');
  const p = getProject(id);
  if (!p.claudeCode) throw new HttpError(400, '먼저 "Claude Code로 분석"을 눌러 요청 파일을 만드세요');
  if (!fs.existsSync(p.claudeCode.responseFile)) throw new HttpError(404, `응답 파일이 아직 없습니다: ${p.claudeCode.responseFile}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p.claudeCode.responseFile, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new HttpError(400, `응답 파일의 JSON 형식이 올바르지 않습니다: ${e.message}`);
  }
  const elements = store.getElements();
  const flows = store.getFlows();
  const frameIds = new Set(p.frames.map((f) => f.id));
  const errors = [];
  for (const [fid, list] of Object.entries(data.inventory || {})) {
    if (!frameIds.has(fid)) { errors.push(`없는 화면 id의 요소 목록을 버렸습니다: ${fid}`); continue; }
    p.inventory[fid] = arr(list).filter((e) => e && validBox(e.box) && typeof e.name === 'string')
      .map((e, i) => ({ id: `${fid}-c${i + 1}`, name: e.name, kind: INVENTORY_SCHEMA.properties.elements.items.properties.kind.enum.includes(e.kind) ? e.kind : 'other', text: strOr(e.text), box: e.box }));
  }
  let imported = 0;
  for (const tcId of p.claudeCode.tcIds) {
    const r = data.results && data.results[tcId];
    if (!r) { errors.push(`${tcId}: 응답에 결과가 없습니다`); continue; }
    let tc;
    try { tc = store.getTc(tcId); } catch { errors.push(`${tcId}: TC가 삭제되었습니다`); continue; }
    const lines = tcLines(tc, elements, flows);
    storeResult(p, tc, verifyResult(normalizeRaw(r), { p, lines, elements }), 'claude-code');
    imported += 1;
  }
  p.lastRun = { at: new Date().toISOString(), model: 'claude-code', errors };
  saveProject(p);
  return { ...view(id), imported };
}

// ---- 분석 실행 (Claude API) ----
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
        storeResult(p, tc, verifyResult(raw, { p, lines, elements }), 'api');
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
  startAnalysis, analyzeRules, exportForClaudeCode, importClaudeCode, view, review, apply, estimate,
  tcLines, verifyResult, confidence, coverage, MAPPING_SCHEMA, INVENTORY_SCHEMA, SYSTEM, projDir,
};
