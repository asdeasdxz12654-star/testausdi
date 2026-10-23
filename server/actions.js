// TC에 쓰는 플랫폼 중립 액션과 플랫폼별 지원 여부.
// run: 실행, noop: 해당 플랫폼에선 의미가 없어 건너뜀(통과 처리), unsupported: 이 액션이 있으면 TC 전체 Skipped
// target: screen(화면) / element(요소) / flow(공통 흐름) / path(응답 JSON 경로, 직접 입력) / schema(data/schemas의 명세)
const PLATFORMS = ['pc', 'mw', 'android', 'ios', 'api'];

const PLATFORM_LABELS = { pc: 'PC 웹', mw: 'MW', android: '안드로이드', ios: '아이폰', api: 'API' };

// 화면 조작 액션: API 플랫폼에서는 쓸 수 없다
const ui = (mode) => ({ pc: mode, mw: mode, android: mode, ios: mode, api: 'unsupported' });
const web = (pc, mw = pc) => ({ pc, mw, android: 'unsupported', ios: 'unsupported', api: 'unsupported' });
// API 액션: API 플랫폼 단독으로, 또는 웹 TC 안에서 사전 조건 준비·검증에 쓴다 (브라우저와 쿠키 공유)
const apiS = { pc: 'run', mw: 'run', android: 'unsupported', ios: 'unsupported', api: 'run' };

const ACTIONS = {
  open: { label: '화면 열기', target: 'screen', support: ui('run') },
  input: { label: '입력', target: 'element', value: true, support: ui('run') },
  tap: { label: '탭/클릭', target: 'element', support: ui('run') },
  select: { label: '목록 선택', target: 'element', value: true, support: web('run') },
  hover: { label: '마우스 올리기', target: 'element', support: web('run', 'unsupported') },
  hideKeyboard: { label: '키보드 닫기', support: { ...ui('run'), pc: 'noop' } },
  back: { label: '뒤로 가기', support: ui('run') },
  assertText: { label: '문구 확인', target: 'element', value: true, assert: true, support: ui('run') },
  assertVisible: { label: '노출 확인', target: 'element', assert: true, support: ui('run') },
  assertHidden: { label: '미노출 확인', target: 'element', assert: true, support: ui('run') },
  assertUrl: { label: '주소 확인', value: true, assert: true, support: web('run') },
  assertScreenshot: { label: '화면 비교 (시각적 회귀)', target: 'element', targetOptional: true, value: true, assert: true, placeholder: '기준 이미지 이름 (예: login-default)', support: web('run') },
  assertA11y: { label: '접근성 검사', value: true, valueOptional: true, assert: true, options: ['critical', 'serious', 'moderate', 'minor'], placeholder: 'serious (이 수준 이상 위반이면 실패)', support: web('run') },
  apiRequest: { label: 'API 요청', value: true, body: true, placeholder: 'GET /posts/1', support: apiS },
  assertStatus: { label: '응답 코드 확인', value: true, assert: true, placeholder: '200 또는 2xx', support: apiS },
  assertJson: { label: '응답 값 확인', target: 'path', value: true, assert: true, placeholder: '기대값 (* 는 값이 있기만 하면 통과)', support: apiS },
  assertSchema: { label: '응답 형식 확인 (스키마)', target: 'schema', assert: true, support: apiS },
  saveValue: { label: '응답 값 저장', target: 'path', value: true, placeholder: '저장 이름 → 다음 스텝에서 {{saved.이름}}', support: apiS },
  flow: { label: '공통 흐름', target: 'flow', support: { ...ui('run'), api: 'run' } },
};

const API_ACTIONS = Object.keys(ACTIONS).filter((k) => ACTIONS[k].support === apiS);

module.exports = { PLATFORMS, PLATFORM_LABELS, ACTIONS, API_ACTIONS };
