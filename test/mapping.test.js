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
  await assert.rejects(figma.fetchFrames('https://www.figma.com/design/Nope/Shop?node-id=1-1', 't', { fetchImpl: async () => ({ ok: false, status: 403 }) }), /권한/);
});

test('ai 설정: 키 원문은 화면에 돌려주지 않는다', () => {
  const s = ai.saveSettings({ apiKey: 'sk-ant-api03-abcdefghijklmnop', figmaToken: 'figd_1234567890' });
  assert.strictEqual(s.apiKey, 'sk-ant-…mnop');
  assert.strictEqual(s.apiKeySource, 'saved');
  assert.ok(!JSON.stringify(s).includes('abcdefghij'));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
