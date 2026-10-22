// 엑셀 TC 가져오기. 머리글로 열을 찾고, 병합 셀·여러 행 TC를 묶고,
// 절차·기대결과 문장을 요소 맵 이름과 동사로 자동화 스텝으로 바꾼다.
// 확신할 수 없는 문장은 바꾸지 않고 이유를 남긴다 (그 TC는 "수동 유지"로 가져온다).
const ExcelJS = require('exceljs');

const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, '').toLowerCase();

// ---- 열 인식 ----
const FIELDS = {
  id: { label: 'TC ID', exact: ['tcid', 'tc-id', 'tc번호', 'tcno', 'id', 'no', 'no.', '번호', '케이스id', '테스트케이스id', 'testcaseid'] },
  title: { label: '제목', exact: ['제목', 'tc명', '테스트항목', '테스트케이스명', '케이스명', '시나리오', '항목', 'title', '확인항목', '테스트명', 'summary', '요약', '테스트내용', '점검항목'], has: ['명', '항목', '제목', 'title'] },
  category: { label: '분류', multi: true, exact: ['대분류', '중분류', '소분류', '분류', '화면', '메뉴', '기능', '화면명', 'depth1', 'depth2', 'depth3', '1depth', '2depth', '3depth', '모듈', '카테고리', 'category'] },
  precondition: { label: '사전조건', exact: ['사전조건', '전제조건', '선행조건', 'precondition', 'preconditions', '테스트조건'], has: ['조건'] },
  steps: { label: '절차', exact: ['절차', '테스트절차', '수행절차', '단계', 'step', 'steps', 'teststeps', '테스트단계', '재현절차', '수행방법', '테스트방법', '테스트스텝'], has: ['절차', 'step', '단계'] },
  expected: { label: '기대결과', exact: ['기대결과', '예상결과', 'expected', 'expectedresult', 'expectedresults', '기대값'], has: ['기대', 'expected', '예상'] },
  priority: { label: '우선순위', exact: ['우선순위', '중요도', 'priority', '등급'], has: ['우선', 'priority', '중요'] },
  platform: { label: '플랫폼', exact: ['플랫폼', 'os', '환경', '디바이스', 'platform', '테스트환경', 'device', '대상'], has: ['플랫폼', 'platform'] },
  reqIds: { label: '요구사항 ID', exact: ['요구사항', '요구사항id', '정책', '정책id', 'req', 'reqid', 'requirement', '기획id', '화면id'], has: ['요구사항', 'req'] },
};

function fieldOf(header) {
  const h = norm(header);
  if (!h) return null;
  for (const [f, d] of Object.entries(FIELDS)) if (d.exact.includes(h)) return f;
  // 결과 열(Pass/Fail 기록)은 기대결과와 헷갈리지 않게 제외
  if (/^(결과|테스트결과|수행결과|result|status|비고|담당자|테스터)/.test(h)) return null;
  for (const [f, d] of Object.entries(FIELDS)) if (d.has && d.has.some((k) => h.includes(k))) return f;
  return null;
}

function detectMapping(headers) {
  const mapping = { category: [] };
  headers.forEach((h, i) => {
    const f = fieldOf(h);
    if (!f) return;
    if (FIELDS[f].multi) mapping.category.push(i);
    else if (mapping[f] === undefined) mapping[f] = i;
  });
  return mapping;
}

// ---- 셀 값 ----
function valueText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return valueText(v.text);
    if (v.result !== undefined) return valueText(v.result);
    if (v.error) return '';
    return '';
  }
  return String(v);
}

// 병합 셀의 나머지 칸은 같은 값을 돌려주므로, 대표 칸이 아니면 "이어지는 칸"으로 본다
function readCell(row, col) {
  const cell = row.getCell(col + 1);
  const continuation = cell.isMerged && cell.master && cell.master.address !== cell.address;
  return { text: continuation ? '' : valueText(cell.value).replace(/\r\n?/g, '\n').trim(), continuation };
}

// ---- 값 변환 ----
function mapPriority(raw) {
  const p = norm(raw);
  if (!p) return 'P2';
  if (/^(p?1|상|높음|high|a|긴급|critical|blocker|major|필수)$/.test(p)) return 'P1';
  if (/^(p?3|하|낮음|low|c|minor|trivial)$/.test(p)) return 'P3';
  return 'P2';
}

function mapPlatforms(raw, fallback) {
  let t = String(raw || '').toLowerCase();
  if (!t.trim()) return fallback;
  if (/공통|전체|all|전\s*플랫폼/.test(t)) return ['pc', 'mw', 'android', 'ios'];
  const out = new Set();
  if (/\bmw\b|모바일\s*웹|mobile\s*web|m\.?web|모웹/.test(t)) { out.add('mw'); t = t.replace(/\bmw\b|모바일\s*웹|mobile\s*web|m\.?web|모웹/g, ' '); }
  if (/\bpc\b|\bweb\b|웹|데스크톱|desktop/.test(t)) out.add('pc');
  if (/\baos\b|android|안드로이드|\bapp\b|앱/.test(t)) out.add('android');
  if (/\bios\b|아이폰|iphone|ipad|\bapp\b|앱/.test(t)) out.add('ios');
  return out.size ? ['pc', 'mw', 'android', 'ios'].filter((p) => out.has(p)) : fallback;
}

const splitList = (raw) => String(raw || '').split(/[,\n/;]+/).map((s) => s.trim()).filter(Boolean);

function splitLines(text) {
  return String(text || '')
    .split(/\n|(?<=\S)\s+(?=\d{1,2}[.)]\s)/)
    .map((l) => l.replace(/^\s*(?:\d{1,2}[.)]|\(\d{1,2}\)|[-•·▶*])\s*/, '').trim())
    .filter(Boolean);
}

// ---- 문장 → 스텝 ----
const SUFFIX = /(입력\s*창|입력\s*란|입력\s*필드|입력\s*칸|필드|버튼|문구|텍스트|영역|아이콘|링크|탭|메뉴|칸)$/;

function buildIndex(elements) {
  const entries = [];
  const add = (key, type, label) => {
    const names = new Set([norm(label)]);
    const stripped = norm(String(label).replace(SUFFIX, ''));
    if (stripped.length >= 2) names.add(stripped);
    names.forEach((n) => { if (n.length >= 2) entries.push({ key, type, name: n, full: n === norm(label) }); });
  };
  Object.entries(elements.elements).forEach(([k, e]) => add(k, 'element', e.label));
  Object.entries(elements.screens).forEach(([k, s]) => add(k, 'screen', s.label));
  return entries.sort((a, b) => b.name.length - a.name.length);
}

// 줄인 이름("비밀번호 입력창" → "비밀번호")은 뒤에 조사나 동작어가 올 때만 인정한다.
// "비밀번호 필수 안내 노출"처럼 다른 대상을 꾸미는 경우를 입력창으로 오인하지 않기 위해서다
const AFTER_SHORT = /^(에서|으로|에|이|가|은|는|을|를|의|로|란|칸|창|입력|기입|작성|클릭|탭|터치|누름|누르|누른|선택|체크|노출|표시|미노출|비노출|보임|보이|사라|진입|이동|접속|화면)/;

function findTarget(line, index, prefer) {
  const n = norm(line);
  const hits = index.filter((e) => {
    const at = n.indexOf(e.name);
    if (at < 0) return false;
    if (e.full) return true;
    const rest = n.slice(at + e.name.length);
    return rest === '' || AFTER_SHORT.test(rest);
  });
  if (!hits.length) return null;
  const best = hits[0].name.length;
  const top = hits.filter((h) => h.name.length === best);
  return top.find((h) => h.type === prefer) || top.find((h) => h.full) || top[0];
}

const QUOTE = /["“”'‘’「『]([^"“”'‘’」』]+)["“”'‘’」』]/;
const quoted = (line) => { const m = line.match(QUOTE); return m ? m[1] : null; };
const HANGUL = /[가-힣]/;

// "아이디 입력창에 standard_user 입력"에서 값 추출. 한글 설명("잘못된 비밀번호")은 값으로 보지 않는다
function inputValue(line) {
  const q = quoted(line);
  if (q !== null) return { value: q };
  const m = line.match(/(?:에|란에|칸에|창에|에서)\s+(.+?)\s*(?:을|를)?\s*(?:입력|기입|작성)/);
  if (m && !HANGUL.test(m[1])) return { value: m[1].trim() };
  return { reason: '입력값을 따옴표로 적어주세요 (예: 비밀번호 입력창에 "abc123" 입력)' };
}

function convertStepLine(line, index) {
  if (/뒤로\s*가기|백\s*키|백\s*버튼|이전\s*화면/.test(line)) return { step: { action: 'back' } };
  if (/키보드.*(닫|내림|내리|숨)/.test(line)) return { step: { action: 'hideKeyboard' } };
  const isOpen = /(진입|접속|이동|열기|열고|방문|실행)/.test(line);
  const target = findTarget(line, index, isOpen ? 'screen' : 'element');
  if (!target) return { reason: '요소 맵에서 대상 화면·요소를 찾지 못했습니다' };
  if (target.type === 'screen') {
    if (isOpen) return { step: { action: 'open', target: target.key } };
    return { reason: '화면 이름은 찾았지만 동작(진입/이동)을 알 수 없습니다' };
  }
  if (/입력|기입|작성/.test(line)) {
    const v = inputValue(line);
    return v.reason ? v : { step: { action: 'input', target: target.key, value: v.value } };
  }
  if (/선택/.test(line) && quoted(line) !== null) return { step: { action: 'select', target: target.key, value: quoted(line) } };
  if (/(마우스|커서).*(올|오버)|hover/i.test(line)) return { step: { action: 'hover', target: target.key } };
  if (/클릭|탭|터치|누름|누르|누른|선택|체크|버튼/.test(line)) return { step: { action: 'tap', target: target.key } };
  return { reason: '동작(입력/클릭/진입 등)을 알 수 없습니다' };
}

function convertExpectedLine(line, index, elements) {
  const hidden = /(미노출|노출되지\s*않|사라|비노출|보이지\s*않|숨김|표시되지\s*않|나타나지\s*않)/.test(line);
  const moved = /(이동|진입|전환|화면.*노출)/.test(line);
  const target = findTarget(line, index, moved && !quoted(line) ? 'screen' : 'element');
  if (!target) {
    return { reason: quoted(line) !== null ? '문구를 확인할 요소를 찾지 못했습니다 (요소 맵에 등록 필요)' : '요소 맵에서 확인할 대상을 찾지 못했습니다' };
  }
  if (target.type === 'screen') {
    const web = elements.screens[target.key].web;
    if (moved && web && web !== '/') return { step: { action: 'assertUrl', value: web } };
    return { reason: '화면 이동 확인은 화면의 웹 경로가 있어야 변환됩니다' };
  }
  if (hidden) return { step: { action: 'assertHidden', target: target.key } };
  const q = quoted(line);
  if (q !== null) return { step: { action: 'assertText', target: target.key, value: q } };
  if (/(노출|표시|보임|보인|나타|출력|활성)/.test(line)) return { step: { action: 'assertVisible', target: target.key } };
  return { reason: '확인 방법(노출/미노출/문구)을 알 수 없습니다' };
}

function convertTc(stepsText, expectedText, elements) {
  const index = buildIndex(elements);
  const lines = [];
  const steps = [];
  for (const text of splitLines(stepsText)) {
    const r = convertStepLine(text, index);
    lines.push({ kind: 'step', text, ok: !!r.step, step: r.step || null, reason: r.reason || null });
    if (r.step) steps.push(r.step);
  }
  for (const text of splitLines(expectedText)) {
    const r = convertExpectedLine(text, index, elements);
    lines.push({ kind: 'expected', text, ok: !!r.step, step: r.step || null, reason: r.reason || null });
    if (r.step) steps.push(r.step);
  }
  const problems = [];
  if (!lines.length) problems.push('절차·기대결과가 비어 있습니다');
  if (lines.some((l) => !l.ok)) problems.push(`변환하지 못한 문장 ${lines.filter((l) => !l.ok).length}개`);
  if (lines.length && !steps.some((s) => s.action.startsWith('assert'))) problems.push('기대결과를 확인하는 스텝이 없습니다');
  if (steps.length && steps[0].action !== 'open') problems.push('첫 스텝이 화면 진입(open)이 아닙니다');
  return { steps, lines, convertible: problems.length === 0, problems };
}

// ---- 시트 읽기 ----
const fail = (status, message) => Object.assign(new Error(message), { status });

// CSV/TSV. 한국어 엑셀은 CSV를 EUC-KR(CP949)로 저장하는 경우가 많아 UTF-8이 아니면 EUC-KR로 읽는다
function decodeText(buffer) {
  let buf = buffer;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function parseCsv(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvWorkbook(buffer, name) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(name || 'CSV').replace(/\.(csv|tsv|txt)$/i, '').slice(0, 31) || 'CSV');
  parseCsv(decodeText(buffer)).forEach((r) => ws.addRow(r));
  return wb;
}

async function loadWorkbook(buffer, fileName = '') {
  if (/\.(csv|tsv|txt)$/i.test(fileName)) return csvWorkbook(buffer, fileName);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw fail(400, `파일을 읽지 못했습니다. .xlsx 또는 .csv 형식인지 확인하세요 (${e.message})`);
  }
  return wb;
}

// ---- Google 스프레드시트 ----
// 링크 공유된 시트를 xlsx로 내려받는다 (병합 셀·여러 시트가 그대로 온다). 로그인이 필요한 비공개 시트는 읽을 수 없다
function googleSheetId(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.hostname !== 'docs.google.com') return null;
  const m = u.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : null;
}

async function fetchGoogleSheet(url, fetchImpl = fetch) {
  const id = googleSheetId(url);
  if (!id) throw fail(400, 'Google 스프레드시트 링크가 아닙니다. https://docs.google.com/spreadsheets/d/... 형식의 링크를 붙여넣으세요');
  let res;
  try {
    res = await fetchImpl(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw fail(502, `Google 스프레드시트에 접속하지 못했습니다: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  const finalHost = (() => { try { return new URL(res.url).hostname; } catch { return ''; } })();
  const needShare = 'Google 스프레드시트의 공유 설정을 "링크가 있는 모든 사용자 - 뷰어"로 바꾼 뒤 다시 시도하세요. 비공개 시트는 파일 → 다운로드 → Microsoft Excel(.xlsx)로 받아 파일로 올리세요';
  if (res.status === 401 || res.status === 403 || finalHost === 'accounts.google.com') throw fail(403, `이 시트를 읽을 권한이 없습니다. ${needShare}`);
  if (res.status === 404) throw fail(404, '시트를 찾을 수 없습니다. 링크가 맞는지 확인하세요');
  if (!res.ok) throw fail(502, `Google 스프레드시트 내려받기 실패 (HTTP ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw fail(403, `시트 대신 다른 페이지가 왔습니다. ${needShare}`);
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="([^"]+)"/i);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `Google 스프레드시트 ${id.slice(0, 8)}.xlsx`;
  return { buffer, fileName: name, sheetId: id };
}

function headerRowOf(ws) {
  let best = null;
  const max = Math.min(ws.rowCount, 20);
  for (let r = 1; r <= max; r += 1) {
    const row = ws.getRow(r);
    const headers = [];
    for (let c = 0; c < Math.max(ws.columnCount, 1); c += 1) headers.push(valueText(row.getCell(c + 1).value));
    const m = detectMapping(headers);
    const score = Object.keys(m).filter((k) => k !== 'category' && m[k] !== undefined).length + (m.category.length ? 1 : 0);
    if ((m.steps !== undefined || m.title !== undefined) && score >= 2 && (!best || score > best.score)) best = { row: r, headers, mapping: m, score };
  }
  return best;
}

function sanitizeId(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '-');
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

// 엑셀 → TC 초안 목록. mapping을 주면 자동 인식 대신 그 열 배치를 쓴다
async function parseWorkbook(buffer, { fileName = '', sourceUrl = null, sheet, mapping: override, elements, existingIds = [], defaultPlatforms = ['pc', 'mw'] }) {
  const wb = await loadWorkbook(buffer, fileName);
  const sheets = wb.worksheets.map((w) => w.name);
  if (!sheets.length) throw Object.assign(new Error('시트가 없습니다'), { status: 400 });
  const ws = (sheet && wb.getWorksheet(sheet)) || wb.worksheets.find((w) => headerRowOf(w)) || wb.worksheets[0];
  const found = headerRowOf(ws);
  if (!found && !override) {
    return { fileName, sourceUrl, sheets, sheet: ws.name, headerRow: null, headers: [], mapping: { category: [] }, tcs: [], warnings: ['머리글 행을 찾지 못했습니다. "테스트 절차", "기대결과" 같은 머리글이 있는지 확인하거나 열을 직접 지정하세요'] };
  }
  const headerRow = found ? found.row : 1;
  const headers = found ? found.headers : [];
  const mapping = override ? { category: [], ...override } : found.mapping;
  const warnings = [];
  if (mapping.steps === undefined) warnings.push('"절차" 열을 찾지 못했습니다. 스텝 없이 가져오면 수동 유지 TC가 됩니다');
  if (mapping.expected === undefined) warnings.push('"기대결과" 열을 찾지 못했습니다');

  const get = (row, f) => (mapping[f] === undefined || mapping[f] === null ? { text: '', continuation: false } : readCell(row, mapping[f]));
  const blocks = [];
  let cur = null;
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const id = get(row, 'id');
    const title = get(row, 'title');
    const steps = get(row, 'steps');
    const expected = get(row, 'expected');
    const cats = (mapping.category || []).map((c) => readCell(row, c));
    const any = [id, title, steps, expected, get(row, 'precondition'), ...cats].some((c) => c.text);
    if (!any) continue;
    const startsNew = mapping.id !== undefined && mapping.id !== null ? !!id.text : !!title.text;
    if (startsNew || !cur) {
      cur = {
        row: r, rawId: id.text, title: title.text,
        categories: cats.map((c) => c.text).filter(Boolean),
        precondition: get(row, 'precondition').text, steps: [steps.text], expected: [expected.text],
        priority: get(row, 'priority').text, platform: get(row, 'platform').text, reqIds: get(row, 'reqIds').text,
      };
      blocks.push(cur);
    } else {
      cur.steps.push(steps.text);
      cur.expected.push(expected.text);
      if (title.text && !cur.title) cur.title = title.text;
      cats.forEach((c) => { if (c.text && !cur.categories.includes(c.text)) cur.categories.push(c.text); });
    }
  }

  const used = new Set(existingIds);
  const seen = new Set();
  let auto = 1;
  const tcs = blocks.map((b) => {
    let id = sanitizeId(b.rawId);
    const notes = [];
    if (b.rawId && !id) notes.push(`원래 ID "${b.rawId}"는 영문·숫자·-·_ 외 문자가 있어 새 ID를 붙였습니다`);
    if (id && seen.has(id)) { notes.push(`파일 안에서 ID "${id}"가 중복되어 새 ID를 붙였습니다`); id = null; }
    if (!id) {
      while (used.has(`TC-IMP-${String(auto).padStart(3, '0')}`) || seen.has(`TC-IMP-${String(auto).padStart(3, '0')}`)) auto += 1;
      id = `TC-IMP-${String(auto).padStart(3, '0')}`;
      auto += 1;
    }
    seen.add(id);
    const stepsText = b.steps.filter(Boolean).join('\n');
    const expectedText = b.expected.filter(Boolean).join('\n');
    const conv = convertTc(stepsText, expectedText, elements);
    const title = b.title || (b.categories.length ? b.categories.join(' > ') : '') || splitLines(expectedText)[0] || id;
    const tc = {
      id,
      title,
      priority: mapPriority(b.priority),
      automation: conv.convertible ? '적합' : '수동 유지',
      tags: b.categories,
      reqIds: splitList(b.reqIds),
      platforms: mapPlatforms(b.platform, defaultPlatforms),
      precondition: b.precondition,
      steps: conv.steps,
      source: { file: fileName, ...(sourceUrl ? { url: sourceUrl } : {}), sheet: ws.name, row: b.row, originalId: b.rawId || null, steps: stepsText, expected: expectedText },
    };
    return { tc, lines: conv.lines, problems: conv.problems, notes, exists: used.has(id) };
  });
  return { fileName, sourceUrl, sheets, sheet: ws.name, headerRow, headers, mapping, tcs, warnings };
}

// ---- 양식 ----
async function templateWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TC');
  ws.columns = [
    { header: 'TC ID', width: 16 }, { header: '대분류', width: 12 }, { header: '중분류', width: 14 },
    { header: '테스트 항목', width: 36 }, { header: '사전조건', width: 22 }, { header: '테스트 절차', width: 48 },
    { header: '기대결과', width: 48 }, { header: '우선순위', width: 10 }, { header: '플랫폼', width: 14 }, { header: '요구사항 ID', width: 14 },
  ];
  ws.addRow(['TC-LOGIN-101', '로그인', '비밀번호 오류', '잘못된 비밀번호 입력 시 에러 문구 노출', '로그아웃 상태',
    '1. 로그인 화면 진입\n2. 아이디 입력창에 "standard_user" 입력\n3. 비밀번호 입력창에 "wrong_pw" 입력\n4. 로그인 버튼 클릭',
    '로그인 에러 문구에 "Epic sadface: Username and password do not match any user in this service" 노출', '상', 'PC, MW', 'LGN-03']);
  ws.addRow(['TC-CART-101', '장바구니', '담기', '상품 담기 시 장바구니 배지 노출', '로그인 상태',
    '1. 상품 목록 화면 진입\n2. 백팩 담기 버튼 클릭', '장바구니 수량 배지에 "1" 노출', '중', '공통', 'CRT-01']);
  ws.getRow(1).font = { bold: true };
  ws.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  const guide = wb.addWorksheet('작성 방법');
  guide.columns = [{ header: '항목', width: 18 }, { header: '작성 방법', width: 90 }];
  [
    ['TC ID', '영문·숫자·-·_ 만 사용. 비우면 TC-IMP-001처럼 자동으로 붙습니다. ID 칸이 빈 행은 위 TC에 이어집니다(병합 셀 가능).'],
    ['테스트 절차', '한 줄에 한 동작. "OO 화면 진입", "OO 입력창에 "값" 입력", "OO 버튼 클릭", "뒤로 가기", "키보드 닫기"'],
    ['기대결과', '"OO 문구에 "내용" 노출", "OO 노출", "OO 미노출", "OO 화면으로 이동"'],
    ['요소 이름', 'OO 자리에는 AutoTC 요소 맵의 이름(예: 로그인 버튼, 아이디 입력창)을 씁니다. 등록되지 않은 이름은 변환되지 않습니다.'],
    ['값', '입력값과 확인할 문구는 따옴표로 감쌉니다. "잘못된 비밀번호 입력"처럼 설명만 있으면 변환되지 않습니다.'],
    ['우선순위', '상/중/하, 높음/보통/낮음, P1/P2/P3, High/Medium/Low'],
    ['플랫폼', 'PC, MW(모바일 웹), AOS/안드로이드, iOS/아이폰, 공통. 비우면 PC·MW'],
    ['결과', '변환하지 못한 문장이 있는 TC는 "수동 유지"로 가져오고 원문을 함께 보관합니다. TC 편집 화면에서 스텝을 채우면 자동화됩니다.'],
  ].forEach((r) => guide.addRow(r));
  guide.getRow(1).font = { bold: true };
  guide.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  return wb.xlsx.writeBuffer();
}

module.exports = {
  FIELDS, fieldOf, detectMapping, mapPriority, mapPlatforms, splitLines, convertTc, parseWorkbook, templateWorkbook,
  decodeText, parseCsv, googleSheetId, fetchGoogleSheet,
};
