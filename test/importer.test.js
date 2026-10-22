const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const importer = require('../server/importer');

const elements = {
  screens: { 'screen.login': { label: '로그인', web: '/' }, 'screen.inventory': { label: '상품 목록', web: '/inventory.html' } },
  elements: {
    'login.id': { label: '아이디 입력창' },
    'login.pw': { label: '비밀번호 입력창' },
    'login.submit': { label: '로그인 버튼' },
    'login.error': { label: '로그인 에러 문구' },
    'header.cartBadge': { label: '장바구니 수량 배지' },
    'inventory.sort': { label: '정렬 선택' },
  },
};

// 실무 양식처럼: 위에 제목 행, 머리글은 3행, ID 병합으로 TC 하나가 두 행, 결과 열 포함
async function sampleBook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('로그인');
  ws.addRow(['쇼핑앱 로그인 TC v1.2']);
  ws.addRow([]);
  ws.addRow(['No', '대분류', '중분류', '테스트 항목', '사전 조건', '테스트 절차', '기대 결과', '중요도', 'OS', '결과', '비고']);
  ws.addRow(['LGN_001', '로그인', '정상', '정상 로그인', '로그아웃 상태', '1. 로그인 화면 진입\n2. 아이디 입력창에 "standard_user" 입력', '', '상', '공통', 'Pass', '']);
  ws.addRow(['', '', '', '', '', '3. 비밀번호 입력창에 secret_sauce 입력\n4. 로그인 버튼 클릭', '상품 목록 화면으로 이동', '', '', '', '']);
  ws.mergeCells('A4:A5');
  ws.mergeCells('D4:D5');
  ws.addRow(['LGN_002', '로그인', '실패', '잘못된 비밀번호', '', '1) 로그인 화면 진입 2) 아이디 입력창에 "standard_user" 입력 3) 비밀번호 입력창에 잘못된 비밀번호 입력 4) 로그인 버튼 탭', '로그인 에러 문구에 “Epic sadface: Username and password do not match” 노출', '중', 'AOS, iOS', 'Fail', '']);
  ws.addRow(['로그인-003', '로그인', '', '', '', '로그인 화면 진입\n로그인 버튼 클릭', '로그인 에러 문구 노출\n장바구니 수량 배지 미노출', '하', 'MW', '', '']);
  ws.addRow([]);
  ws.addRow(['LGN_001', '로그인', '', '중복 ID', '', '로그인 화면 진입', '로그인 에러 문구 노출', '', '', '', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('fieldOf: 한국어·영어 머리글을 인식하고 결과 열은 무시한다', () => {
  assert.strictEqual(importer.fieldOf('테스트 절차'), 'steps');
  assert.strictEqual(importer.fieldOf('Expected Result'), 'expected');
  assert.strictEqual(importer.fieldOf('기대 결과'), 'expected');
  assert.strictEqual(importer.fieldOf('결과'), null);
  assert.strictEqual(importer.fieldOf('테스트 결과'), null);
  assert.strictEqual(importer.fieldOf('사전 조건'), 'precondition');
  assert.strictEqual(importer.fieldOf('No'), 'id');
  assert.strictEqual(importer.fieldOf('중분류'), 'category');
});

test('mapPriority·mapPlatforms', () => {
  assert.deepStrictEqual(['상', '높음', 'High', 'P1', '중', '하', 'low', ''].map(importer.mapPriority), ['P1', 'P1', 'P1', 'P1', 'P2', 'P3', 'P3', 'P2']);
  assert.deepStrictEqual(importer.mapPlatforms('공통', ['pc']), ['pc', 'mw', 'android', 'ios']);
  assert.deepStrictEqual(importer.mapPlatforms('AOS, iOS', ['pc']), ['android', 'ios']);
  assert.deepStrictEqual(importer.mapPlatforms('모바일웹', ['pc']), ['mw']);
  assert.deepStrictEqual(importer.mapPlatforms('PC Web / MW', ['pc']), ['pc', 'mw']);
  assert.deepStrictEqual(importer.mapPlatforms('', ['pc', 'mw']), ['pc', 'mw']);
});

test('splitLines: 줄바꿈과 한 줄 안의 번호 목록을 나눈다', () => {
  assert.deepStrictEqual(importer.splitLines('1) 가 2) 나 3) 다'), ['가', '나', '다']);
  assert.deepStrictEqual(importer.splitLines('1. 가\n- 나\n\n• 다'), ['가', '나', '다']);
});

test('convertTc: 문장을 스텝으로 바꾸고, 값이 설명뿐이면 바꾸지 않는다', () => {
  const ok = importer.convertTc('로그인 화면 진입\n아이디 입력창에 "qa" 입력\n비밀번호 입력창에 pw!23 입력\n로그인 버튼 클릭\n정렬 선택에서 "lohi" 선택\n뒤로 가기',
    '로그인 에러 문구에 "오류" 노출\n장바구니 수량 배지 미노출\n상품 목록 화면으로 이동', elements);
  assert.deepStrictEqual(ok.steps, [
    { action: 'open', target: 'screen.login' },
    { action: 'input', target: 'login.id', value: 'qa' },
    { action: 'input', target: 'login.pw', value: 'pw!23' },
    { action: 'tap', target: 'login.submit' },
    { action: 'select', target: 'inventory.sort', value: 'lohi' },
    { action: 'back' },
    { action: 'assertText', target: 'login.error', value: '오류' },
    { action: 'assertHidden', target: 'header.cartBadge' },
    { action: 'assertUrl', value: '/inventory.html' },
  ]);
  assert.strictEqual(ok.convertible, true);

  // 줄인 이름 "비밀번호"는 조사·동작어가 뒤따를 때만 비밀번호 입력창으로 본다
  const short = importer.convertTc('비밀번호에 "pw" 입력\n아이디 클릭', '비밀번호 필수 안내 노출', elements);
  assert.deepStrictEqual(short.lines.map((l) => (l.step ? `${l.step.action}:${l.step.target}` : 'X')), ['input:login.pw', 'tap:login.id', 'X']);

  const bad = importer.convertTc('로그인 화면 진입\n비밀번호 입력창에 잘못된 비밀번호 입력\n회원가입 버튼 클릭', '"환영합니다" 노출', elements);
  assert.strictEqual(bad.convertible, false);
  assert.match(bad.lines[1].reason, /따옴표/);
  assert.match(bad.lines[2].reason, /찾지 못했습니다/);
  assert.match(bad.lines[3].reason, /문구를 확인할 요소/);
});

test('parseWorkbook: 머리글 행 찾기, 병합 셀로 이어진 TC, ID 정리, 중복 ID, 원문 보관', async () => {
  const p = await importer.parseWorkbook(await sampleBook(), { fileName: 'tc.xlsx', elements, existingIds: ['LGN_002'] });
  assert.strictEqual(p.headerRow, 3);
  assert.strictEqual(p.mapping.expected, 6);
  assert.deepStrictEqual(p.mapping.category, [1, 2]);
  assert.strictEqual(p.tcs.length, 4);

  const [a, b, c, d] = p.tcs;
  assert.strictEqual(a.tc.id, 'LGN_001');
  assert.strictEqual(a.tc.title, '정상 로그인');
  assert.strictEqual(a.tc.priority, 'P1');
  assert.deepStrictEqual(a.tc.platforms, ['pc', 'mw', 'android', 'ios']);
  assert.deepStrictEqual(a.tc.tags, ['로그인', '정상']);
  assert.strictEqual(a.tc.steps.length, 5, '두 행에 걸친 절차 4개 + 기대결과 1개');
  assert.strictEqual(a.tc.automation, '적합');
  assert.strictEqual(a.tc.source.row, 4);
  assert.match(a.tc.source.steps, /secret_sauce/);

  assert.strictEqual(b.exists, true);
  assert.strictEqual(b.tc.automation, '수동 유지');
  assert.deepStrictEqual(b.tc.platforms, ['android', 'ios']);
  assert.strictEqual(b.lines.length, 5);
  assert.ok(b.lines.find((l) => /잘못된 비밀번호/.test(l.text) && !l.ok));

  assert.strictEqual(c.tc.id, 'TC-IMP-001');
  assert.strictEqual(c.tc.source.originalId, '로그인-003');
  assert.strictEqual(c.tc.title, '로그인', '제목이 없으면 분류로');
  assert.match(c.notes[0], /새 ID/);
  assert.strictEqual(c.tc.automation, '적합');

  assert.strictEqual(d.tc.id, 'TC-IMP-002');
  assert.match(d.notes[0], /중복/);
});

test('templateWorkbook: 양식을 다시 읽으면 예시 TC가 자동화 가능으로 변환된다', async () => {
  const buf = Buffer.from(await importer.templateWorkbook());
  const sauce = {
    screens: { 'screen.login': { label: '로그인', web: '/' }, 'screen.inventory': { label: '상품 목록', web: '/inventory.html' } },
    elements: {
      'login.id': { label: '아이디 입력창' }, 'login.pw': { label: '비밀번호 입력창' }, 'login.submit': { label: '로그인 버튼' },
      'login.error': { label: '로그인 에러 문구' }, 'inventory.addBackpack': { label: '백팩 담기 버튼' }, 'header.cartBadge': { label: '장바구니 수량 배지' },
    },
  };
  const p = await importer.parseWorkbook(buf, { fileName: 'AutoTC_TC양식.xlsx', elements: sauce });
  assert.deepStrictEqual(p.sheets, ['TC', '작성 방법']);
  assert.deepStrictEqual(p.tcs.map((t) => [t.tc.id, t.tc.automation]), [['TC-LOGIN-101', '적합'], ['TC-CART-101', '적합']]);
});

// ---- CSV / Google 스프레드시트 ----
// Node에는 EUC-KR 인코더가 없어 디코더로 코드표를 거꾸로 만든다
function eucKr(text) {
  const dec = new TextDecoder('euc-kr');
  const table = new Map();
  for (let a = 0x81; a <= 0xfe; a += 1) {
    for (let b = 0x41; b <= 0xfe; b += 1) {
      const ch = dec.decode(Buffer.from([a, b]));
      if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, [a, b]);
    }
  }
  return Buffer.from([...text].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : table.get(ch))));
}

test('decodeText: UTF-8(BOM), EUC-KR, UTF-16LE', () => {
  assert.strictEqual(importer.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('테스트 절차')])), '테스트 절차');
  assert.strictEqual(importer.decodeText(eucKr('테스트 절차,기대결과')), '테스트 절차,기대결과');
  assert.strictEqual(importer.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('절차', 'utf16le')])), '절차');
});

test('parseCsv: 따옴표 안 쉼표·줄바꿈·이스케이프, CRLF, TSV 자동 판별', () => {
  assert.deepStrictEqual(importer.parseCsv('a,"b, c","줄1\r\n줄2"\r\nx,"say ""hi""",\n'), [['a', 'b, c', '줄1\r\n줄2'], ['x', 'say "hi"', '']]);
  assert.deepStrictEqual(importer.parseCsv('TC ID\t테스트 절차\nT1\t1. 진입'), [['TC ID', '테스트 절차'], ['T1', '1. 진입']]);
});

test('parseWorkbook: EUC-KR CSV를 엑셀과 같은 규칙으로 가져온다', async () => {
  const csv = [
    'TC ID,테스트 항목,테스트 절차,기대결과,우선순위,플랫폼',
    'CSV-001,잘못된 비밀번호,"1. 로그인 화면 진입',
    '2. 아이디 입력창에 ""qa"" 입력',
    '3. 로그인 버튼 클릭",로그인 에러 문구 노출,상,MW',
    ',,4. 뒤로 가기,,,',
  ].join('\r\n');
  const p = await importer.parseWorkbook(eucKr(csv), { fileName: 'tc.csv', elements });
  assert.strictEqual(p.sheet, 'tc');
  assert.strictEqual(p.tcs.length, 1);
  const { tc } = p.tcs[0];
  assert.deepStrictEqual([tc.id, tc.title, tc.priority, tc.platforms.join()], ['CSV-001', '잘못된 비밀번호', 'P1', 'mw']);
  assert.deepStrictEqual(tc.steps.map((s) => s.action), ['open', 'input', 'tap', 'back', 'assertVisible']);
  assert.strictEqual(tc.steps[1].value, 'qa');
  assert.strictEqual(tc.automation, '적합');
});

test('googleSheetId: docs.google.com 스프레드시트 링크만 받는다', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
  assert.strictEqual(importer.googleSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.strictEqual(importer.googleSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
  assert.strictEqual(importer.googleSheetId(`https://evil.example.com/spreadsheets/d/${id}`), null);
  assert.strictEqual(importer.googleSheetId(`https://docs.google.com/document/d/${id}/edit`), null);
  assert.strictEqual(importer.googleSheetId('스프레드시트'), null);
});

test('fetchGoogleSheet: xlsx 내려받기, 파일명, 비공개·없는 시트·엉뚱한 응답 구분', async () => {
  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
  const xlsx = Buffer.from(await importer.templateWorkbook());
  const fake = (status, body, { finalUrl, cd } = {}) => async (reqUrl) => {
    assert.match(reqUrl, /\/export\?format=xlsx$/);
    return { status, ok: status < 400, url: finalUrl || reqUrl, headers: new Headers(cd ? { 'content-disposition': cd } : {}), arrayBuffer: async () => body };
  };
  const ok = await importer.fetchGoogleSheet(url, fake(200, xlsx, { cd: "attachment; filename=\"TC.xlsx\"; filename*=UTF-8''%EB%A1%9C%EA%B7%B8%EC%9D%B8%20TC.xlsx" }));
  assert.strictEqual(ok.fileName, '로그인 TC.xlsx');
  assert.strictEqual(ok.buffer.length, xlsx.length);

  await assert.rejects(importer.fetchGoogleSheet(url, fake(200, Buffer.from('<html>login'), { finalUrl: 'https://accounts.google.com/ServiceLogin' })), (e) => e.status === 403 && /링크가 있는 모든 사용자/.test(e.message));
  await assert.rejects(importer.fetchGoogleSheet(url, fake(401, Buffer.from(''))), (e) => e.status === 403);
  await assert.rejects(importer.fetchGoogleSheet(url, fake(404, Buffer.from('<html>'))), (e) => e.status === 404 && /찾을 수 없습니다/.test(e.message));
  await assert.rejects(importer.fetchGoogleSheet(url, fake(200, Buffer.from('<!doctype html>'))), (e) => e.status === 403 && /다른 페이지/.test(e.message));
  await assert.rejects(importer.fetchGoogleSheet('https://example.com/x', fake(200, xlsx)), (e) => e.status === 400);
});
