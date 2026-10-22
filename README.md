# AutoTC

매뉴얼 TC(절차 + 기대결과)를 한 번 등록하면 PC 웹, 모바일 웹(MW), 안드로이드 앱에서 자동으로 실행하고, 결과를 QA 판정 방식(Pass / Fail / Flaky / Blocked / Skipped)과 결함 초안·이슈 목록으로 돌려주는 테스트 자동화 실행기입니다. 아이폰은 현재 사전 점검과 Maestro YAML 생성까지 지원합니다.

## 실행

1. [Node.js](https://nodejs.org) LTS(20 이상)를 설치합니다.
2. 프로젝트 폴더의 **`AutoTC.exe`** 를 더블클릭합니다.
   - 처음 실행하면 패키지와 테스트용 Chromium을 자동으로 설치합니다 (인터넷 필요, 수 분).
   - 브라우저가 열리고 콘솔(`http://127.0.0.1:4870`)이 나타납니다.
   - 검은 창을 닫으면 AutoTC가 종료됩니다.

`AutoTC.exe`가 없으면 `npm run build:exe`로 다시 만들 수 있습니다. Windows가 아니면 `npm start`로 실행합니다.

| 명령 | 설명 |
|---|---|
| `npm start` | 콘솔 실행 (exe와 같음) |
| `npm run ci -- --tags smoke` | 화면 없이 실행하고 종료 기준으로 성공/실패 판정 (아래 CI 참고) |
| `npm test` | 핵심 로직 단위 테스트 |
| `npm run build:exe` | `launcher/AutoTC.cs` → `AutoTC.exe` 빌드 (Windows 기본 csc.exe 사용) |

포트를 바꾸려면 환경변수 `AUTOTC_PORT`를 지정합니다. 콘솔은 이 PC(127.0.0.1)에서만 열립니다.

## 안드로이드 실행 준비

1. [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)를 설치하고 `adb`를 PATH에 추가합니다.
2. Java 17 이상과 [Maestro](https://maestro.mobile.dev)를 설치합니다. Windows는 zip을 풀고 `bin` 폴더를 PATH에 추가합니다.
3. 폰에서 개발자 옵션 → USB 디버깅을 켜고 PC에 연결한 뒤 "USB 디버깅 허용"을 승인합니다. 테스트 중에는 화면이 켜져 있고 잠금이 풀려 있어야 합니다.
4. `data/config.json`의 `android`를 채웁니다.
   - `appId`: 앱 패키지명 (예: `com.example.shop`)
   - `apkPath`: 실행 전에 설치할 APK 경로 (선택, 비우면 이미 설치된 앱 사용)
   - `serial`: 기기가 여러 대일 때 쓸 기기 (선택, `adb devices`의 첫 칸)
5. 요소 맵의 **안드로이드 id** 칸에 resource-id를 입력합니다. 앱 안에서 다른 화면으로 바로 가야 하는 `open` 스텝은 화면 표의 **안드로이드 딥링크**가 필요합니다.
6. 기기 관리 화면에서 모든 항목이 ✓인지 확인하고 실행 현황에서 안드로이드를 체크해 실행합니다.

동작 방식:
- TC마다 `launchApp(clearState)`로 앱 데이터를 초기화한 뒤 시작합니다. 입력 전에는 기존 값을 지웁니다(`eraseText`).
- 문구 확인(assertText)은 "요소 노출"과 "문구 일치" 두 명령으로 나눠, 요소가 없는지(스크립트·UI 문제) 문구가 다른지(제품 결함)를 구분합니다.
- 실행마다 logcat을 비우고 끝나면 저장합니다. 대상 앱의 `FATAL EXCEPTION`·ANR이 있으면 오류 유형 CRASH, 결함 심각도 Critical로 잡습니다.
- 식별자가 없는 요소를 쓰는 TC는 실행하지 않고 Blocked로 남깁니다. 요소 맵의 "개발팀 요청 목록"으로 요청하세요.
- 기기는 한 대에서 TC를 하나씩 실행합니다. TC 하나의 제한 시간은 `run.mobileTimeoutMs`(기본 5분)입니다.

## CI (GitHub Actions)

`.github/workflows/autotc.yml`이 GitHub에 올라가면 자동으로 동작합니다.

| 언제 | 무엇을 |
|---|---|
| `main` 푸시, PR | 단위 테스트 → `@smoke` TC를 PC 웹·MW에서 실행 |
| 매일 03:00 (KST) | `@regression` TC 실행 (야간 회귀) |
| Actions 탭에서 수동 실행 | 태그·플랫폼을 지정해 실행 |

- 종료 기준(`data/config.json`의 `exitCriteria`)을 못 맞추면 워크플로가 실패로 표시됩니다.
- 실행 요약이 Actions 실행 화면에 표로 나오고, `summary.md`, `junit.xml`, 스크린샷·영상·트레이스, Playwright HTML 리포트를 아티팩트로 14일간 보관합니다.
- 결함을 일부러 심은 예시 TC(`demo-bug` 태그)는 CI에서 제외합니다.
- 슬랙 알림: 저장소 Settings → Secrets에 `AUTOTC_SLACK_WEBHOOK`(수신 웹훅 URL)을 넣으면 실행마다 결과를 보냅니다.
- CI의 이슈·이력은 실행마다 새로 시작합니다. 이슈를 이어서 관리하는 것은 로컬 콘솔에서 합니다.

명령줄 옵션:

```
npm run ci -- --platforms pc,mw --tags smoke --exclude-tags demo-bug --label "스모크" --out report
  --tc TC-LOGIN-001,TC-CART-001   지정한 TC만
  --no-gate                       종료 기준을 못 맞춰도 성공 처리 (리포트만 필요할 때)
종료 코드: 0 충족 · 1 미충족 · 2 실행 오류
```

## 화면

| 화면 | 하는 일 |
|---|---|
| 실행 현황 | 플랫폼·스위트를 골라 실행, 종료 기준 충족 여부, 플랫폼별 결과, 실패 목록, 실패만 재실행 |
| 결과 상세 | 스텝별 통과/실패, 오류, 실패 시점 스크린샷·영상·트레이스, 실패 분류 확정, 결함 초안 복사 |
| TC 편집 | 표 형식으로 TC 작성, 플랫폼별 지원 여부 표시, 엔진별 코드(Playwright / Maestro) 미리보기 |
| 요소 맵 | 논리 이름(`login.submit`) ↔ 플랫폼별 식별자 관리, 개발팀 식별자 요청문 생성 |
| 기기 관리 | 플랫폼별 사전 점검 결과와 준비 방법 |
| 이슈 관리 | 실패 시그니처로 묶인 이슈, 유형·심각도·상태·이슈 트래커 ID 관리, 재검증 실행 |

## 데이터

| 위치 | 내용 | Git |
|---|---|---|
| `data/tcs/*.json` | TC 1건당 파일 1개 | 관리 |
| `data/elements.json` | 화면·요소 맵 | 관리 |
| `data/flows.json` | 공통 흐름 (예: 로그인) | 관리 |
| `data/testdata.json` | 계정·입력값. TC에서 `{{account.id}}`로 참조 | 관리 (실제 계정은 넣지 마세요) |
| `data/config.json` | 대상 URL, 기기 프리셋, 안드로이드 앱 정보, 재시도·타임아웃, 종료 기준, 격리 기준 | 관리 |
| `data/state/` | 실행 결과·증적, 이슈, 판정 이력 | 제외 |
| `generated/` | 실행마다 생성되는 Playwright 스크립트 | 제외 |

예시 TC는 연습 사이트 [saucedemo.com](https://www.saucedemo.com)을 대상으로 합니다. `TC-CHECKOUT-002`는 일부러 결함이 심어진 `problem_user` 계정을 써서 실패·분류·이슈 흐름을 보여주는 TC입니다.

## 판정과 분류 규칙

- **Flaky**: 첫 시도 실패, 자동 재시도 통과. 최근 10회 중 3회 이상 Flaky면 격리되어 통과율에서 빠집니다.
- **Blocked**: 사전 점검 실패(URL 접속 불가, 브라우저·기기 없음 등)나 스크립트 변환 실패. 통과율에서 빠지고 종료 기준에서 따로 셉니다.
- **실패 분류 제안**: 값이 다름 → 제품 결함 의심 / 요소 없음 + 다른 플랫폼에선 같은 스텝 통과 → 스크립트 수정 필요 / 요소 없음 + 모든 플랫폼 실패 → 제품 결함 또는 UI 변경 / 네트워크·타임아웃 → 환경 문제. 확정은 QA가 결과 상세 화면에서 합니다.
- **이슈**: `플랫폼 | TC | 스텝 | 오류 유형 | 대상`이 같으면 같은 이슈로 묶고 발생 횟수만 올립니다. 수정 완료 후 재검증이 Pass면 종료, 다시 실패하면 재오픈됩니다.

## 구조

```
AutoTC.exe            런처 (node scripts/start.js 실행)
launcher/AutoTC.cs    런처 소스
scripts/start.js      첫 실행 설치 → 서버 시작 → 브라우저 열기
scripts/ci.js         명령줄 실행 (CI용), 요약·JUnit 생성, 슬랙 알림
.github/workflows/    GitHub Actions 워크플로
server/
  index.js            로컬 HTTP 서버 + API
  runner.js           사전 점검 → 생성 → Playwright·Maestro 실행 → 판정 → 분류 → 이슈 반영
  android.js          안드로이드 어댑터 (ADB 기기 정보, Maestro 실행, logcat, 결과 해석)
  report.js           CI용 Markdown 요약, JUnit XML
  generator.js        TC JSON → Playwright(.spec.ts) / Maestro(YAML)
  tc.js               TC 검증, 공통 흐름 펼치기, 테스트 데이터 치환
  classify.js         오류 유형, 실패 분류, 시그니처, 결함 초안
  issues.js           이슈 생성·중복 묶기·재검증·격리
  precheck.js         플랫폼별 사전 점검
  reporter.js         Playwright 커스텀 리포터
web/                  콘솔 화면 (빌드 없는 HTML/CSS/JS)
data/                 TC, 요소 맵, 설정
test/                 단위 테스트
```

## 아직 안 되는 것

- 아이폰 **실행** (사전 점검과 YAML 생성만 됨)
- 안드로이드 여러 기기 동시 실행 (지금은 한 대에서 순서대로)
- 엑셀 TC 가져오기
- 기획서·피그마 기반 TC 영역 매핑 (기획서 12장)
