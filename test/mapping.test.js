// TC 영역 매핑 테스트. 실제 Claude API·피그마 대신 가짜 클라이언트로 요청 형태와 검증·확신도·반영 규칙을 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotc-mapping-'));
process.env.AUTOTC_DATA = tmp;
delete process.env.ANTHROPIC_API_KEY;

const store = require('../server/store');
const mapping = require('../server/mapping');
const ai = require('../server/ai');
const figma = require('../server/figma');

const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
write(path.join(tmp, 'config.json'), { project: 't', env: 't', baseURL: 'http://x', ai: { model: 'claude-opus-5-5', effort: 'high' } });
write(path.join(tmp, 'elements.json'), {
  screens: { 'screen.login': { label: '로그인', web: '/' } },
  elements: {
    'login.id': { label: '아이디 입력창', web: { testId: 'id' } },
    'login.pw': { label: '비밀번호 입력창', web: { testId: 'pw' } },
    'login.submit': { label: '로그인 버튼', web: { testId: 'go' } },
  },
});
write(path.join(tmp, 'flows.json'), {});
write(path.join(tmp, 'testdata.json'), {});
const tc = (id, title, steps, extra = {}) => write(path.join(tmp, 'tcs', `${id}.json`), { id, title, priority: 'P1', automation: '적합', tags: [], reqIds: [], platforms: ['pc'], precondition: '', steps, ...extra });
tc('TC-1', '비밀번호 오류 문구', [
  { action: 'open', target: 'screen.login' },
  { action: 'tap', target: 'login.submit' },
  { action: 'assertText', target: 'login.pw', value: '비밀번호가 일치하지 않습니다' },
]);
tc('TC-2', '계정 잠금 팝업', [], { automation: '수동 유지', source: { file: 'a.xlsx', sheet: 'S', row: 3, steps: '로그인 5회 실패', expected: '잠금 팝업 노출' } });
tc('TC-3', '확인 버튼', [{ action: 'open', target: 'screen.login' }, { action: 'tap', target: 'login.submit' }]);

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const SPEC = 'LGN-03 비밀번호 불일치 시 입력창 하단에 "비밀번호가 일치하지 않습니다" 안내 문구 노출\nLGN-05 5회 실패 시 계정 잠금';

// 가짜 Claude: 요청을 기록하고 TC별로 정해 둔 답을 돌려준다
const requests = [];
const answers = {
  'TC-1': {
    frame: 'F1',
    steps: [
      { lineNo: 1, frame: 'F1', name: '로그인 화면', elementKey: '', suggestedKey: '', box: [0, 0, 1, 1], candidates: 1, designTextMatch: true, note: '' },
      { lineNo: 2, frame: 'F1', name: '로그인 버튼', elementKey: 'login.submit', suggestedKey: '', box: [0.1, 0.6, 0.8, 0.08], candidates: 1, designTextMatch: true, note: '' },
      { lineNo: 3, frame: 'F1', name: '비밀번호 오류 문구', elementKey: '', suggestedKey: 'login.pwError', box: [0.1, 0.5, 0.8, 0.03], candidates: 1, designTextMatch: true, note: '' },
    ],
    evidence: [
      { doc: 'S1', policyId: 'LGN-03', quote: '비밀번호 불일치 시 입력창 하단에 "비밀번호가 일치하지 않습니다" 안내 문구 노출', page: -1 },
      { doc: 'S1', policyId: 'LGN-99', quote: '비밀번호는 90일마다 변경', page: -1 },
    ],
    missingInDesign: [], specGap: false, notes: '',
  },
  'TC-2': { frame: '', steps: [{ lineNo: 1, frame: '', name: '', elementKey: '', suggestedKey: '', box: [], candidates: 0, designTextMatch: false, note: '디자인 없음' }, { lineNo: 2, frame: '', name: '', elementKey: '', suggestedKey: '', box: [], candidates: 0, designTextMatch: false, note: '' }], evidence: [], missingInDesign: ['잠금 팝업'], specGap: true, notes: '' },
  'TC-3': { frame: 'F9', steps: [{ lineNo: 1, frame: 'F1', name: '로그인 화면', elementKey: '', suggestedKey: '', box: [0, 0, 1, 1], candidates: 1, designTextMatch: true, note: '' }, { lineNo: 2, frame: 'F1', name: '확인', elementKey: 'login.nope', suggestedKey: '', box: [0.1, 0.6, 0.8, 0.08], candidates: 3, designTextMatch: false, note: '후보 3개' }], evidence: [{ doc: 'S1', policyId: 'LGN-03', quote: 'LGN-03 비밀번호 불일치 시', page: -1 }], missingInDesign: [], specGap: false, notes: '' },
};
const fakeClient = {
  beta: {
    messages: {
      stream(params) {
        requests.push(params);
        const last = params.messages[0].content.at(-1).text;
        let data;
        if (/UI 요소/.test(last)) data = { elements: [{ name: '로그인 버튼', kind: 'button', text: '로그인', box: [0.1, 0.6, 0.8, 0.08] }, { name: '비밀번호 찾기', kind: 'link', text: '비밀번호 찾기', box: [0.3, 0.75, 0.4, 0.03] }, { name: '로고', kind: 'image', text: '', box: [0.4, 0.05, 0.2, 0.1] }] };
        else data = answers[(last.match(/TC (TC-\d)/) || [])[1]];
        return { finalMessage: async () => ({ stop_reason: 'end_turn', model: params.model, content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: requests.length > 1 ? 5000 : 0, cache_creation_input_tokens: requests.length === 1 ? 5000 : 0 } }) };
      },
    },
  },
};

const analyze = (id, body) => new Promise((resolve) => mapping.startAnalysis(id, body, { client: fakeClient, onDone: resolve }));

test('동의 없이는 분석하지 않는다', () => {
  const p = mapping.createProject('동의');
  mapping.addFile(p.id, { kind: 'frame', fileName: '01_Login.png', data: PNG.toString('base64') });
  assert.throws(() => mapping.startAnalysis(p.id, { tcIds: ['TC-1'] }, { client: fakeClient }), /동의/);
});

test('분석: 요청 형태, 인용 검증, 확신도, 커버리지, 검토·반영', async () => {
  ai.saveSettings({ consent: true });
  const p = mapping.createProject('로그인');
  mapping.addFile(p.id, { kind: 'frame', fileName: '01_Login.png', data: PNG.toString('base64') });
  mapping.addFile(p.id, { kind: 'spec', fileName: '로그인 기획.md', data: Buffer.from(SPEC).toString('base64') });
  mapping.updateProject(p.id, { tcIds: ['TC-1', 'TC-2', 'TC-3', 'TC-없음'] });
  assert.deepStrictEqual(mapping.getProject(p.id).tcIds, ['TC-1', 'TC-2', 'TC-3']);

  const done = await analyze(p.id, {});
  assert.strictEqual(done.status, 'done', done.error);
  assert.strictEqual(requests.length, 4, '프레임 요소 1번 + TC 3번');

  // 요청 형태: 같은 자료 묶음, 마지막 자료 블록에 캐시, JSON 스키마, 폴백
  const r0 = requests[0];
  assert.strictEqual(r0.model, 'claude-opus-5-5');
  assert.deepStrictEqual(r0.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(r0.fallbacks, 'default');
  assert.strictEqual(r0.output_config.effort, 'high');
  assert.strictEqual(r0.output_config.format.type, 'json_schema');
  const content = r0.messages[0].content;
  const cached = content.findIndex((b) => b.cache_control);
  assert.strictEqual(cached, content.length - 2, '캐시 표시는 TC별 문장 바로 앞');
  assert.ok(content.some((b) => b.type === 'image'));
  assert.ok(requests.every((r) => JSON.stringify(r.messages[0].content.slice(0, -1)) === JSON.stringify(content.slice(0, -1))), '모든 요청의 앞부분이 같아야 캐시가 맞는다');

  const v = mapping.view(p.id);
  const r1 = v.results['TC-1'];
  assert.strictEqual(r1.confidence.level, 'high', r1.confidence.reasons.join());
  assert.strictEqual(r1.evidence.length, 1, '기획서에 없는 인용은 버린다');
  assert.ok(r1.warnings.some((w) => /찾을 수 없는 인용/.test(w)));
  assert.strictEqual(v.results['TC-2'].confidence.level, 'none');
  assert.deepStrictEqual(v.results['TC-2'].steps.map((s) => s.text), ['로그인 5회 실패', '잠금 팝업 노출'], '스텝 없는 TC는 엑셀 원문으로 분석');
  const r3 = v.results['TC-3'];
  assert.strictEqual(r3.frame, '', '없는 화면 id는 버린다');
  assert.strictEqual(r3.steps[1].elementKey, '', '요소 맵에 없는 이름은 버린다');
  assert.strictEqual(r3.confidence.level, 'low');

  assert.deepStrictEqual(v.coverage.uncovered.map((e) => e.name), ['비밀번호 찾기'], '이미지는 빼고, 로그인 버튼은 TC가 다룸');
  assert.deepStrictEqual(v.coverage.noEvidence, ['TC-2']);
  assert.strictEqual(v.usage.calls, 4);
  assert.ok(v.usd > 0);

  // 검토: 수정 승인 → edited, 그대로 승인 → approved, 기획 문의
  mapping.review(p.id, 'TC-1', { status: 'approved' });
  mapping.review(p.id, 'TC-3', { status: 'approved', edits: [{ lineNo: 2, elementKey: 'login.submit' }] });
  mapping.review(p.id, 'TC-2', { status: 'inquiry', note: '잠금 팝업 디자인 요청' });
  assert.throws(() => mapping.review(p.id, 'TC-1', { edits: [{ lineNo: 2, elementKey: 'login.none' }] }), /요소 맵에 없는/);
  const s = mapping.view(p.id).stats;
  assert.deepStrictEqual(s.high, { total: 1, reviewed: 1, approvedAsIs: 1 });
  assert.deepStrictEqual(s.low, { total: 1, reviewed: 1, approvedAsIs: 0 });

  const out = mapping.apply(p.id);
  assert.deepStrictEqual(out.elementsAdded, ['login.pwError']);
  assert.deepStrictEqual(out.tcsUpdated.sort(), ['TC-1', 'TC-3']);
  const el = store.getElements().elements['login.pwError'];
  assert.strictEqual(el.label, '비밀번호 오류 문구');
  assert.strictEqual(el.web, null);
  const t1 = store.getTc('TC-1');
  assert.deepStrictEqual(t1.reqIds, ['LGN-03']);
  assert.strictEqual(t1.mapping.frame, '01_Login');
  assert.ok(!store.getTc('TC-2').mapping, '문의 상태는 반영하지 않는다');
});

test('verifyResult: 피그마 텍스트 레이어가 있으면 문구 일치를 직접 확인한다', () => {
  const p = { id: 'x', frames: [{ id: 'F1', texts: [{ text: '비밀번호가 일치하지 않습니다.', box: [0, 0, 1, 1] }] }], specs: [] };
  const lines = [{ no: 1, text: '에러 문구에 "비밀번호가 일치하지 않습니다" 노출', kind: 'expected' }, { no: 2, text: '에러 문구에 "아이디 없음" 노출', kind: 'expected' }];
  const raw = { frame: 'F1', steps: lines.map((l) => ({ lineNo: l.no, frame: 'F1', name: 'x', elementKey: '', suggestedKey: '', box: [0.1, 0.1, 0.2, 0.1], candidates: 1, designTextMatch: true, note: '' })), evidence: [], missingInDesign: [], specGap: false, notes: '' };
  const v = mapping.verifyResult(raw, { p, lines, elements: { elements: {}, screens: {} } });
  assert.deepStrictEqual(v.steps.map((s) => [s.designTextMatch, s.textCheck]), [[true, 'figma'], [false, 'figma']]);
  assert.strictEqual(mapping.confidence(v).level, 'low');
});

test('confidence: 요소가 없는 스텝(키보드 닫기 등)은 영역을 못 찾아도 감점하지 않는다', () => {
  const step = (lineNo, needsElement, box) => ({ lineNo, text: 'x', needsElement, frame: 'F1', box, candidates: box ? 1 : 0, designTextMatch: true });
  const r = { frame: 'F1', evidence: [{ verified: true }], missingInDesign: [], steps: [step(1, false, [0, 0, 1, 1]), step(2, false, null), step(3, true, [0.1, 0.1, 0.2, 0.1])] };
  assert.strictEqual(mapping.confidence(r).level, 'high');
  r.steps.push(step(4, true, null));
  assert.deepStrictEqual(mapping.confidence(r), { level: 'mid', reasons: ['영역을 찾지 못한 문장 1개'] });
  r.steps.pop();
  // 절차 문장의 따옴표는 입력값이라 화면 문구와 달라도 감점하지 않고, 기대결과 문장만 비교한다
  r.steps.push({ ...step(5, true, [0.1, 0.3, 0.2, 0.1]), kind: 'step', text: '비밀번호 입력창에 "wrong_pw" 입력', designTextMatch: false });
  assert.strictEqual(mapping.confidence(r).level, 'high');
  r.steps.push({ ...step(6, true, [0.1, 0.4, 0.2, 0.1]), kind: 'expected', text: '에러 문구에 "잠김" 노출', designTextMatch: false });
  assert.strictEqual(mapping.confidence(r).level, 'low');
});

test('figma: 링크 해석과 프레임·텍스트 레이어 가져오기', async () => {
  assert.deepStrictEqual(figma.parseFigmaUrl('https://www.figma.com/design/AbC123/Shop?node-id=12-34&t=x'), { fileKey: 'AbC123', nodeId: '12:34' });
  assert.deepStrictEqual(figma.parseFigmaUrl('https://www.figma.com/design/AbC123/branch/Br9/Shop'), { fileKey: 'Br9', nodeId: null });
  assert.strictEqual(figma.parseFigmaUrl('https://example.com/design/AbC'), null);

  const calls = [];
  const frame = (id, name) => ({ id, name, type: 'FRAME', absoluteBoundingBox: { x: 100, y: 0, width: 400, height: 800 }, children: [
    { type: 'TEXT', name: 'title', characters: '로그인', absoluteBoundingBox: { x: 140, y: 80, width: 80, height: 40 } },
    { type: 'TEXT', name: 'hidden', visible: false, characters: '숨김', absoluteBoundingBox: { x: 100, y: 0, width: 10, height: 10 } },
  ] });
  const fakeFetch = async (url, opts) => {
    calls.push([url, opts && opts.headers && opts.headers['X-Figma-Token']]);
    const json = (d) => ({ ok: true, status: 200, json: async () => d });
    if (url.includes('/nodes?ids=12%3A34')) return json({ nodes: { '12:34': { document: { id: '12:34', type: 'SECTION', children: [frame('1:1', '01_Login'), frame('1:2', '02_Home'), { id: '1:3', type: 'TEXT' }] } } } });
    if (url.includes('/images/')) return json({ images: { '1:1': 'https://cdn/1.png', '1:2': 'https://cdn/2.png' } });
    if (url.startsWith('https://cdn/')) return { ok: true, status: 200, arrayBuffer: async () => PNG };
    return { ok: false, status: 404 };
  };
  const got = await figma.fetchFrames('https://www.figma.com/design/AbC123/Shop?node-id=12-34', 'figd_token', { fetchImpl: fakeFetch });
  assert.deepStrictEqual(got.frames.map((f) => f.name), ['01_Login', '02_Home']);
  assert.deepStrictEqual(got.frames[0].texts, [{ text: '로그인', layer: 'title', box: [0.1, 0.1, 0.2, 0.05] }]);
  assert.strictEqual(calls[0][1], 'figd_token');
  assert.ok(!calls.find((c) => c[0].startsWith('https://cdn/') && c[1]), '이미지 CDN에는 토큰을 보내지 않는다');
  await assert.rejects(figma.fetchFrames('https://www.figma.com/design/AbC123/Shop', '', { fetchImpl: fakeFetch }), /토큰이 없습니다/);

  // 이름으로 버튼·입력창을 찾고, 버튼 안의 글자는 버튼 이름으로 합치며, 화면 절반 이상 큰 레이어는 뺀다
  const nodes = figma.collectNodes({ type: 'FRAME', name: 'Login', absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 800 }, children: [
    { type: 'INSTANCE', name: 'Button/Primary', absoluteBoundingBox: { x: 40, y: 480, width: 320, height: 64 }, children: [{ type: 'TEXT', characters: '로그인' }, { type: 'INSTANCE', name: 'Button/Icon', absoluteBoundingBox: { x: 50, y: 490, width: 20, height: 20 } }] },
    { type: 'FRAME', name: '입력창 아이디', absoluteBoundingBox: { x: 40, y: 200, width: 320, height: 48 }, children: [{ type: 'TEXT', characters: '아이디' }] },
    { type: 'FRAME', name: 'Button area', absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 700 } },
    { type: 'GROUP', name: 'hidden button', visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
  ] });
  assert.deepStrictEqual(nodes.map((n) => [n.kind, n.text]), [['button', '로그인'], ['input', '아이디']]);
  assert.deepStrictEqual(nodes[0].box, [0.1, 0.6, 0.8, 0.08]);
  await assert.rejects(figma.fetchFrames('https://www.figma.com/design/Nope/Shop?node-id=1-1', 't', { fetchImpl: async () => ({ ok: false, status: 403 }) }), /권한/);
});

// 피그마에서 가져온 것처럼 텍스트·버튼 레이어가 있는 화면
const figmaFrame = {
  name: '01_Login_error', png: PNG,
  texts: [
    { text: '로그인', layer: 'title', box: [0.1, 0.05, 0.3, 0.05] },
    { text: '로그인', layer: 'label', box: [0.45, 0.62, 0.1, 0.03] },
    { text: '비밀번호가 일치하지 않습니다.', layer: 'error', box: [0.1, 0.5, 0.8, 0.03] },
    { text: '비밀번호 찾기', layer: 'link', box: [0.35, 0.76, 0.3, 0.02] },
  ],
  nodes: [
    { name: 'Button/Primary', kind: 'button', text: '로그인', box: [0.1, 0.6, 0.8, 0.08] },
    { name: 'Link/FindPw', kind: 'link', text: '비밀번호 찾기', box: [0.3, 0.75, 0.4, 0.04] },
  ],
};
const fakeFigma = { fetchFrames: async () => ({ fileKey: 'K', frames: [figmaFrame], skipped: 0 }) };

test('규칙 기반: 피그마 레이어로 위치를 찾고, 기획서에서 근거 문장을 찾는다 (API 호출 없음)', async () => {
  const p = mapping.createProject('규칙');
  await mapping.addFigma(p.id, 'https://www.figma.com/design/K/x', { figma: fakeFigma });
  mapping.addFile(p.id, { kind: 'spec', fileName: '기획.md', data: Buffer.from(SPEC).toString('base64') });
  mapping.updateProject(p.id, { tcIds: ['TC-1', 'TC-2'] });
  const before = requests.length;
  const v = mapping.analyzeRules(p.id, {});
  assert.strictEqual(requests.length, before, 'Claude를 부르지 않는다');

  const r = v.results['TC-1'];
  assert.strictEqual(r.method, 'rules');
  assert.strictEqual(r.frame, 'F1');
  assert.deepStrictEqual(r.steps[1].box, [0.1, 0.6, 0.8, 0.08], '버튼 안 글자가 아니라 버튼 레이어 영역');
  assert.strictEqual(r.steps[1].candidates, 1);
  assert.deepStrictEqual([r.steps[2].box, r.steps[2].designTextMatch], [[0.1, 0.5, 0.8, 0.03], true]);
  assert.strictEqual(r.evidence[0].policyId, 'LGN-03');
  assert.strictEqual(r.confidence.level, 'high', r.confidence.reasons.join());

  assert.strictEqual(v.results['TC-2'].method, 'rules');
  assert.deepStrictEqual(v.inventory.F1.map((e) => e.name), ['로그인', '비밀번호 찾기'], '피그마 버튼·링크 레이어가 요소 목록');
  assert.deepStrictEqual(v.coverage.uncovered.map((e) => e.name), ['비밀번호 찾기']);
});

test('규칙 기반: 캡처 이미지만 있으면 위치를 지어내지 않고 이유를 남긴다', () => {
  const p = mapping.createProject('캡처만');
  mapping.addFile(p.id, { kind: 'frame', fileName: 'login.png', data: PNG.toString('base64') });
  mapping.updateProject(p.id, { tcIds: ['TC-1'] });
  const r = mapping.analyzeRules(p.id, {}).results['TC-1'];
  assert.strictEqual(r.frame, '');
  assert.ok(r.steps.every((s) => !s.box));
  assert.match(r.warnings.join(), /피그마에서 가져온 화면에서만/);
  assert.strictEqual(r.confidence.level, 'none');
});

test('Claude Code 연계: 요청 파일을 만들고, 응답을 API와 같은 규칙으로 검증해 가져온다', () => {
  const p = mapping.createProject('클로드 코드');
  mapping.addFile(p.id, { kind: 'frame', fileName: '01_Login.png', data: PNG.toString('base64') });
  mapping.addFile(p.id, { kind: 'spec', fileName: '기획.md', data: Buffer.from(SPEC).toString('base64') });
  mapping.updateProject(p.id, { tcIds: ['TC-1', 'TC-3'] });
  assert.throws(() => mapping.importClaudeCode(p.id), /요청 파일을 만드세요/);

  const ex = mapping.exportForClaudeCode(p.id, {});
  const md = fs.readFileSync(ex.claudeCode.requestFile, 'utf8');
  assert.ok(md.includes(path.join(mapping.projDir(p.id), 'frames', 'F1.png')), '화면 파일 경로');
  assert.ok(md.includes('TC TC-1 "비밀번호 오류 문구"') && md.includes('TC TC-3'), 'TC 문장');
  assert.ok(md.includes(ex.claudeCode.responseFile));
  assert.match(ex.prompt, /request\.md 파일을 읽고/);
  assert.throws(() => mapping.importClaudeCode(p.id), /응답 파일이 아직 없습니다/);

  fs.writeFileSync(ex.claudeCode.responseFile, '﻿' + JSON.stringify({
    inventory: { F1: [{ name: '로그인 버튼', kind: 'button', text: '로그인', box: [0.1, 0.6, 0.8, 0.08] }, { name: '찾기', kind: 'link', text: '', box: [0.3, 0.75, 0.4, 0.04] }], F9: [] },
    results: { 'TC-1': answers['TC-1'] },
  }));
  const v = mapping.importClaudeCode(p.id);
  assert.strictEqual(v.imported, 1);
  const r = v.results['TC-1'];
  assert.strictEqual(r.method, 'claude-code');
  assert.strictEqual(r.evidence.length, 1, '지어낸 인용은 API 답과 똑같이 버린다');
  assert.strictEqual(r.confidence.level, 'high');
  assert.deepStrictEqual(v.inventory.F1.map((e) => e.name), ['로그인 버튼', '찾기']);
  assert.ok(v.lastRun.errors.some((e) => /F9/.test(e)) && v.lastRun.errors.some((e) => /TC-3: 응답에 결과가 없습니다/.test(e)));

  fs.writeFileSync(ex.claudeCode.responseFile, '{ 잘못된');
  assert.throws(() => mapping.importClaudeCode(p.id), /JSON 형식/);
});

test('ai 설정: 키 원문은 화면에 돌려주지 않는다', () => {
  const s = ai.saveSettings({ apiKey: 'sk-ant-api03-abcdefghijklmnop', figmaToken: 'figd_1234567890' }); // 가짜 키 secret-scan:allow
  assert.strictEqual(s.apiKey, 'sk-ant-…mnop');
  assert.strictEqual(s.apiKeySource, 'saved');
  assert.ok(!JSON.stringify(s).includes('abcdefghij'));
  assert.throws(() => ai.saveSettings({ apiKey: 'abc123-not-a-claude-key-xxxxx' }), /키 형식이 아닙니다/);
  assert.throws(() => ai.saveSettings({ apiKey: 'sk-ant-abc def' }), /키 형식이 아닙니다/);
  assert.strictEqual(ai.publicSettings().apiKey, 'sk-ant-…mnop', '잘못된 키는 저장하지 않는다');
});

test('checkKey: 무료 모델 조회로 키를 확인하고 오류를 안내한다', async () => {
  const Anthropic = require('@anthropic-ai/sdk');
  const ok = await ai.checkKey({ models: { retrieve: async (id) => ({ id, display_name: 'Claude Opus 5.5' }) } }, 'claude-opus-5-5');
  assert.deepStrictEqual(ok, { ok: true, model: 'claude-opus-5-5', message: '키 정상 · Claude Opus 5.5 사용 가능' });
  const err = new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
  const bad = await ai.checkKey({ models: { retrieve: async () => { throw err; } } }, 'claude-opus-5-5');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.message, /인증 실패/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
