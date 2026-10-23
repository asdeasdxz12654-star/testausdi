// TC 자동 작성: 조건표 → 동등 분할·경계값, 기획서 조건·모호 문장, Claude Code 응답 검증(인용 대조·스텝 재변환), 품질 검사, 반영
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autotc-generate-'));
process.env.AUTOTC_DATA = tmp; // 아래 require보다 먼저 지정해야 store가 이 폴더를 쓴다

const td = require('../server/testdesign');
const g = require('../server/generate');
const store = require('../server/store');

const elements = {
  screens: { 'screen.signup': { label: '회원가입', web: '/signup' } },
  elements: {
    'signup.name': { label: '이름 입력창', web: { testId: 'name' } },
    'signup.age': { label: '나이 입력창', web: { testId: 'age' } },
    'signup.email': { label: '이메일 입력창', web: { testId: 'email' } },
    'signup.plan': { label: '요금제 선택', web: { testId: 'plan' } },
    'signup.submit': { label: '가입 버튼', web: { testId: 'submit' } },
    'signup.error': { label: '가입 오류 문구', web: { testId: 'error' } },
    'signup.done': { label: '가입 완료 문구', web: { testId: 'done' } },
  },
};
fs.mkdirSync(path.join(tmp, 'tcs'), { recursive: true });
store.writeJson(path.join(tmp, 'elements.json'), elements);
store.writeJson(path.join(tmp, 'flows.json'), {});
store.writeJson(path.join(tmp, 'testdata.json'), {});
store.saveTc({ id: 'TC-OLD-001', title: '회원가입 - 정상 제출', priority: 'P1', automation: '적합', tags: [], reqIds: [], platforms: ['pc'], precondition: '', steps: [{ action: 'open', target: 'screen.signup' }, { action: 'assertVisible', target: 'signup.done' }] });

const FORM = [
  td.FORM_HEADER,
  '이름\tsignup.name\t문자\tY\t2\t10\t\t이름을 입력하세요\t이름은 2~10자입니다\t',
  '나이\tsignup.age\t숫자\tN\t14\t99\t\t\t14~99세만 가입할 수 있습니다\t',
  '이메일\tsignup.email\t이메일\tY\t\t\t\t이메일을 입력하세요\t이메일 형식이 아닙니다\t',
  '요금제\tsignup.plan\t선택\tN\t\t\t기본|프로\t\t\t',
].join('\n');
const SPEC = [
  '# 회원가입',
  '- SGN-01 이름은 2자 이상 10자 이하로 입력한다.',
  '- 이름이 비어 있으면 "이름을 입력하세요" 문구를 노출한다.',
  '- SGN-02 가입 버튼을 누르면 가입 완료 화면으로 이동한다.',
  '- 비밀번호는 적절한 길이로 입력받는다.',
  '- 화면 상단에 로고를 보여준다.',
  '# 탈퇴',
  '- SGN-09 탈퇴 시 7일 이내에는 재가입할 수 없다.',
].join('\n');

test('조건표 파싱: 머리글·유형·필수·경계, 잘못된 행은 오류', () => {
  const { fields, errors } = td.parseForm(FORM);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(fields.map((f) => [f.key, f.type, f.required, f.min, f.max]), [
    ['name', 'text', true, 2, 10], ['age', 'number', false, 14, 99], ['email', 'email', true, null, null], ['plan', 'select', false, null, null],
  ]);
  assert.deepStrictEqual(fields[3].options, ['기본', '프로']);
  const bad = td.parseForm(`${td.FORM_HEADER}\n이름\tsignup.name\t날짜\tY\t5\t2`);
  assert.ok(bad.errors.some((e) => e.includes('알 수 없는 유형')));
  assert.ok(bad.errors.some((e) => e.includes('최소가 최대보다')));
  assert.ok(td.parseForm('a\tb\n1\t2').errors[0].includes('머리글'));
});

test('동등 분할·경계값(2값): 최소-1·최소·최대·최대+1, 숫자 아님, 형식 오류, 선택값', () => {
  const { fields } = td.parseForm(FORM);
  const cs = td.formConditions({ name: '회원가입' }, fields);
  const by = Object.fromEntries(cs.map((c) => [c.key, c]));
  assert.strictEqual(by['name:min-1'].value.length, 1);
  assert.strictEqual(by['name:min'].value.length, 2);
  assert.strictEqual(by['name:max'].value.length, 10);
  assert.strictEqual(by['name:max+1'].value.length, 11);
  assert.strictEqual(by['name:max+1'].expected, '이름은 2~10자입니다');
  assert.strictEqual(by['name:required'].expected, '이름을 입력하세요');
  assert.strictEqual(by['name:required'].text, '이름을 비우고 제출하면 필수 오류');
  assert.deepStrictEqual(['age:min-1', 'age:min', 'age:max', 'age:max+1', 'age:nan'].map((k) => by[k].value), ['13', '14', '99', '100', 'abc']);
  assert.strictEqual(by['age:required'], undefined, '필수가 아니면 빈 값 조건이 없다');
  assert.ok(by['email:format'] && !by['email:format'].valid);
  assert.deepStrictEqual([by['plan:opt1'].value, by['plan:opt2'].value], ['기본', '프로']);
  assert.ok(cs.every((c) => c.technique === 'EP' || c.technique === 'BVA'));
  // 최소 1자·필수면 "최소-1"(빈 값)은 필수 조건과 같아 만들지 않는다
  const one = td.formConditions({}, td.parseForm(`${td.FORM_HEADER}\n코드\ta.code\t문자\tY\t1\t4`).fields);
  assert.ok(!one.some((c) => c.key === 'code:min-1'));
  assert.strictEqual(td.emailOf(20).length, 20);
  assert.ok(td.emailOf(20).includes('@'));
  assert.strictEqual(td.josa('비밀번호', '을', '를'), '비밀번호를');
  assert.strictEqual(td.josa('이름', '을', '를'), '이름을');
});

test('기획서: 절 나누기, 조건 문장·경계·기법·우선순위, 모호한 문장, 정책 번호, 범위', () => {
  const secs = td.splitSections(SPEC);
  assert.deepStrictEqual(secs.map((s) => s.title), ['회원가입', '탈퇴']);
  const all = td.scanSpecs([{ id: 'S1', name: 'spec.md', text: SPEC }], null);
  const texts = all.conditions.map((c) => c.text);
  assert.ok(texts.includes('SGN-02 가입 버튼을 누르면 가입 완료 화면으로 이동한다.'), '"누르면"도 조건으로 본다');
  assert.ok(!texts.includes('화면 상단에 로고를 보여준다.'), '"화면"의 "면"은 조건이 아니다');
  const name = all.conditions.find((c) => c.text.startsWith('SGN-01'));
  assert.deepStrictEqual([name.technique, name.boundary.min, name.boundary.max, name.boundary.length], ['BVA', 2, 10, true]);
  const empty = all.conditions.find((c) => c.text.startsWith('이름이 비어'));
  assert.deepStrictEqual([empty.type, empty.priority], ['negative', 'P2']);
  assert.strictEqual(all.conditions.find((c) => c.text.includes('탈퇴')).boundary.max, 7);
  assert.ok(all.questions.some((q) => q.quote.includes('적절한')));
  assert.deepStrictEqual(all.policies, ['SGN-01', 'SGN-02', 'SGN-09']);
  const only = td.scanSpecs([{ id: 'S1', name: 'spec.md', text: SPEC }], new Set(['S1#1']));
  assert.ok(only.conditions.every((c) => c.section === '탈퇴'));
  assert.ok(td.formRowHint(name).startsWith('이름\t\t문자\t\t2\t10'));
});

let pid;
test('규칙 기반: 조건 → 승인 → 데이터 행 TC 초안, 품질 검사 배지', () => {
  pid = g.createProject('회원가입').id;
  g.addFile(pid, { kind: 'spec', fileName: 'spec.md', data: Buffer.from(SPEC).toString('base64') });
  g.updateProject(pid, {
    idPrefix: 'TC-SIGNUP-',
    form: { name: '회원가입', text: FORM, screen: 'screen.signup', submit: 'signup.submit', error: 'signup.error', success: { kind: 'visible', target: 'signup.done' }, platforms: ['pc'], priority: 'P1' },
  });
  let v = g.rulesConditions(pid);
  const formC = v.conditions.filter((c) => c.source === 'form');
  assert.ok(formC.length > 10);
  // 조건표의 근거가 된 기획서 문장은 따로 조건으로 만들지 않고 근거로 붙인다
  const nameReq = formC.find((c) => c.form.key === 'name:required');
  assert.ok(nameReq.evidence.some((e) => e.quote.includes('"이름을 입력하세요"') && e.verified));
  assert.ok(!v.conditions.some((c) => c.source === 'spec' && c.text.startsWith('이름이 비어')));
  assert.ok(v.questions.length >= 1);

  // 다시 뽑아도 검토 결과와 ID가 유지된다
  g.reviewCondition(pid, nameReq.id, { status: 'rejected' });
  v = g.rulesConditions(pid);
  assert.strictEqual(v.conditions.find((c) => c.id === nameReq.id).review.status, 'rejected');

  assert.throws(() => g.rulesDrafts(pid), /승인한 규칙 기반 조건이 없습니다/);
  g.reviewCondition(pid, nameReq.id, { status: 'pending' });
  v = g.reviewConditions(pid, { status: 'approved' });
  assert.ok(v.changed > 10);
  v = g.rulesDrafts(pid);
  const titles = v.drafts.map((d) => d.title);
  assert.ok(titles.includes('회원가입 - 정상 제출'));
  const bad = v.drafts.find((d) => d.title === '회원가입 - 잘못된 값 검증');
  assert.strictEqual(bad.checks.runnable, 'ok');
  assert.ok(bad.dataSets.length >= 8);
  assert.ok(bad.dataSets.every((r) => r.values.error), '모든 무효 조건에 오류 문구가 있어 문구까지 확인한다');
  assert.deepStrictEqual(bad.steps.at(-1), { action: 'assertText', target: 'signup.error', value: '{{row.error}}' });
  const nameMax = bad.dataSets.find((r) => r.name.includes('11자(최대+1)'));
  assert.strictEqual(nameMax.values.name.length, 11);
  assert.strictEqual(nameMax.values.age, '56', '다른 필드는 유효한 대표값');
  const ok = v.drafts.find((d) => d.title === '회원가입 - 정상 제출');
  assert.strictEqual(ok.checks.duplicates[0].id, 'TC-OLD-001', '기존 TC와 제목이 같으면 중복 의심');
  const specOnly = v.drafts.find((d) => d.method === 'rules' && !d.steps.length);
  assert.strictEqual(specOnly.checks.runnable, 'manual');
});

test('조건표 검사: 없는 요소는 새 요소로, 형식이 틀리면 오류', () => {
  const p = { form: { name: '가입', text: `${td.FORM_HEADER}\n코드\tsignup.code\t문자\tY`, flow: '', screen: '', submit: 'signup.submit', error: 'bad key', success: { kind: 'url', value: '' }, platforms: [] } };
  const st = g.formState(p, elements, {});
  assert.ok(st.newElements['signup.code']);
  assert.ok(st.errors.some((e) => e.includes('진입 방법')));
  assert.ok(st.errors.some((e) => e.includes('"bad key"')));
  assert.ok(st.errors.some((e) => e.includes('주소 조각')));
  assert.ok(st.errors.some((e) => e.includes('플랫폼')));
});

test('Claude Code: 요청 파일, 원문에 없는 인용은 버림, 틀린 스텝은 자연어에서 다시 변환', () => {
  let v = g.exportForClaudeCode(pid, { stage: 'conditions' });
  const req = fs.readFileSync(v.claudeCode.requestFile, 'utf8');
  assert.ok(req.includes('## 역할') && req.includes('글자 그대로') && req.includes('#### 회원가입'));
  assert.ok(v.prompt.includes(v.claudeCode.responseFile));
  assert.throws(() => g.importClaudeCode(pid), /응답 파일이 아직 없습니다/);
  fs.writeFileSync(v.claudeCode.responseFile, JSON.stringify({
    conditions: [
      { text: '탈퇴 후 7일이 지나면 재가입 가능', technique: 'BVA', type: 'boundary', priority: 'P2', evidence: [{ doc: 'S1', policyId: 'SGN-09', quote: 'SGN-09 탈퇴 시 7일 이내에는 재가입할 수 없다.', page: -1 }], assumption: '' },
      { text: '추천인 코드 입력 시 포인트 지급', technique: 'XX', type: 'positive', priority: 'P9', evidence: [{ doc: 'S1', quote: '추천인 코드를 입력하면 1000포인트를 준다.' }] },
    ],
    questions: [{ text: '"적절한 길이"는 몇 자인가요?', doc: 'S1', quote: '비밀번호는 적절한 길이로 입력받는다.' }],
  }));
  v = g.importClaudeCode(pid);
  const cc = v.conditions.filter((c) => c.source === 'claude-code');
  assert.strictEqual(cc.length, 2);
  assert.ok(cc[0].evidence[0].verified);
  assert.deepStrictEqual([cc[1].evidence.length, cc[1].technique, cc[1].priority], [0, 'EP', 'P2']);
  assert.ok(cc[1].assumption.includes('AI 추정'));
  assert.ok(v.lastRun.warnings.some((w) => w.includes('찾을 수 없는 인용')));
  assert.ok(v.questions.some((q) => q.source === 'claude-code' && q.quote));

  g.reviewCondition(pid, cc[0].id, { status: 'approved' });
  v = g.exportForClaudeCode(pid, { stage: 'drafts' });
  const req2 = fs.readFileSync(v.claudeCode.requestFile, 'utf8');
  assert.ok(req2.includes('## 팀 TC 예시') && req2.includes('TC-OLD-001') && req2.includes(cc[0].id));
  fs.writeFileSync(v.claudeCode.responseFile, JSON.stringify({ drafts: [
    { title: '이름 11자 입력', priority: 'P2', platforms: ['pc'], conditionIds: [cc[0].id, cc[1].id], technique: 'BVA',
      stepsText: '회원가입 화면 진입\n이름 입력창에 "가나다라마바사아자차카" 입력\n가입 버튼 탭', expectedText: '가입 오류 문구 노출',
      steps: [{ action: 'open', target: 'screen.signup' }, { action: 'input', target: 'signup.nickname', value: 'x' }] },
    { title: '재가입 제한 안내', priority: 'P2', platforms: ['pc'], conditionIds: [cc[0].id], technique: 'BVA', stepsText: '', expectedText: '정상',
      steps: [{ action: 'open', target: 'screen.rejoin' }, { action: 'assertVisible', target: 'rejoin.notice' }],
      newElements: [{ key: 'screen.rejoin', label: '재가입' }, { key: 'rejoin.notice', label: '재가입 제한 안내' }, { key: 'bad key', label: 'x' }] },
  ] }));
  v = g.importClaudeCode(pid);
  const [a, b] = v.drafts.filter((d) => d.method === 'claude-code');
  assert.deepStrictEqual(a.conditionIds, [cc[0].id], '승인하지 않은 조건 id는 뺀다');
  assert.ok(a.notes.some((n) => n.includes('다시 만들었습니다')));
  assert.strictEqual(a.checks.runnable, 'ok');
  assert.strictEqual(a.steps.at(-1).action, 'assertVisible');
  assert.deepStrictEqual(Object.keys(b.newElements), ['screen.rejoin', 'rejoin.notice']);
  assert.strictEqual(b.checks.runnable, 'needs-locator');
  assert.ok(b.checks.weak, '기대결과 "정상"은 약한 기대결과');
});

test('반영: 승인한 초안만, 다음 번호, 출처 이력·새 요소, 다시 반영하면 409', () => {
  let v = g.view(pid);
  const okDraft = v.drafts.find((d) => d.title === '회원가입 - 잘못된 값 검증');
  const newEl = v.drafts.find((d) => d.title === '재가입 제한 안내');
  const manual = v.drafts.find((d) => d.method === 'rules' && !d.steps.length);
  for (const d of [okDraft, newEl, manual]) g.reviewDraft(pid, d.id, { status: 'approved' });
  g.reviewDraft(pid, v.drafts.find((d) => d.title === '회원가입 - 정상 제출').id, { status: 'rejected', note: 'TC-OLD-001과 중복' });
  store.saveTc({ ...store.getTc('TC-OLD-001'), id: 'TC-SIGNUP-007' });
  v = g.view(pid);
  assert.deepStrictEqual(v.nextIds, ['TC-SIGNUP-008', 'TC-SIGNUP-009', 'TC-SIGNUP-010']);
  const out = g.apply(pid);
  assert.deepStrictEqual(out.tcsAdded, ['TC-SIGNUP-008', 'TC-SIGNUP-009', 'TC-SIGNUP-010']);
  assert.deepStrictEqual(out.elementsAdded.sort(), ['rejoin.notice', 'screen.rejoin']);
  const saved = out.tcsAdded.map((id) => store.getTc(id));
  const rows = saved.find((t) => t.dataSets);
  assert.strictEqual(rows.automation, '적합');
  assert.deepStrictEqual(rows.tags, ['generated']);
  assert.ok(rows.reqIds.includes('SGN-01'));
  assert.strictEqual(rows.generated.project, pid);
  assert.strictEqual(rows.generated.method, 'rules');
  assert.ok(rows.generated.conditionIds.length > 5);
  assert.strictEqual(saved.find((t) => !t.steps.length).automation, '수동 유지');
  const els = store.getElements();
  assert.strictEqual(els.elements['rejoin.notice'].web, null);
  assert.strictEqual(els.screens['screen.rejoin'].generatedFrom, pid);
  assert.throws(() => g.apply(pid), (e) => e.status === 409);
  assert.throws(() => g.reviewDraft(pid, okDraft.id, { status: 'rejected' }), (e) => e.status === 409);
  // TC 편집기에서 다시 저장해도 출처 이력이 남는다
  const { validateTc } = require('../server/tc');
  assert.ok(validateTc(rows, { elements: store.getElements(), flows: {}, schemas: {} }).generated);
  v = g.view(pid);
  assert.strictEqual(v.stats.rules.rejected, 1);
  assert.ok(v.coverage.policies.find((p) => p.id === 'SGN-09').conditions >= 1);
});
