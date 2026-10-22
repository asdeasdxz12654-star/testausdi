// TC에 쓰는 플랫폼 중립 액션과 플랫폼별 지원 여부.
// run: 실행, noop: 해당 플랫폼에선 의미가 없어 건너뜀(통과 처리), unsupported: 이 액션이 있으면 TC 전체 Skipped
const PLATFORMS = ['pc', 'mw', 'android', 'ios'];

const PLATFORM_LABELS = { pc: 'PC 웹', mw: 'MW', android: '안드로이드', ios: '아이폰' };

const all = (mode) => ({ pc: mode, mw: mode, android: mode, ios: mode });

const ACTIONS = {
  open: { label: '화면 열기', target: 'screen', support: all('run') },
  input: { label: '입력', target: 'element', value: true, support: all('run') },
  tap: { label: '탭/클릭', target: 'element', support: all('run') },
  select: { label: '목록 선택', target: 'element', value: true, support: { pc: 'run', mw: 'run', android: 'unsupported', ios: 'unsupported' } },
  hover: { label: '마우스 올리기', target: 'element', support: { pc: 'run', mw: 'unsupported', android: 'unsupported', ios: 'unsupported' } },
  hideKeyboard: { label: '키보드 닫기', support: { pc: 'noop', mw: 'run', android: 'run', ios: 'run' } },
  back: { label: '뒤로 가기', support: all('run') },
  assertText: { label: '문구 확인', target: 'element', value: true, assert: true, support: all('run') },
  assertVisible: { label: '노출 확인', target: 'element', assert: true, support: all('run') },
  assertHidden: { label: '미노출 확인', target: 'element', assert: true, support: all('run') },
  assertUrl: { label: '주소 확인', value: true, assert: true, support: { pc: 'run', mw: 'run', android: 'unsupported', ios: 'unsupported' } },
  flow: { label: '공통 흐름', target: 'flow', support: all('run') },
};

module.exports = { PLATFORMS, PLATFORM_LABELS, ACTIONS };
