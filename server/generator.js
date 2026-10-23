// TC JSON → 엔진별 스크립트 변환. PC 웹·MW·API는 Playwright, 안드로이드·아이폰은 Maestro YAML.
const path = require('path');
const { ACTIONS, PLATFORM_LABELS } = require('./actions');
const { expandSteps, valueParts, resolveValue, rowsOf, stepTitle } = require('./tc');
const { HttpError } = require('./store');

const q = (s) => JSON.stringify(String(s));
const PLATFORM = (p) => PLATFORM_LABELS[p] || p;
// 생성된 스크립트가 불러오는 실행 도우미 (Windows 경로도 / 로)
const RUNTIME = path.join(__dirname, 'runtime.js').split(path.sep).join('/');

function webLocator(name, elements) {
  const el = elements.elements[name];
  if (!el) throw new HttpError(400, `요소 맵에 없는 요소: ${name}`);
  const w = el.web;
  if (!w) throw new HttpError(400, `${name} 요소에 웹 식별자가 없습니다`);
  let expr;
  if (w.testId) expr = `page.getByTestId(${q(w.testId)})`;
  else if (w.role) expr = `page.getByRole(${q(w.role)}${w.name ? `, { name: ${q(w.name)} }` : ''})`;
  else if (w.text) expr = `page.getByText(${q(w.text)}, { exact: true })`;
  else if (w.css) expr = `page.locator(${q(w.css)})`;
  else throw new HttpError(400, `${name} 요소의 웹 식별자 형식이 올바르지 않습니다`);
  if (Number.isInteger(w.nth)) expr += `.nth(${w.nth})`;
  return expr;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// 값 → JS 식. 비밀값은 실행 때 환경변수에서 읽고(rt.secret), 저장값은 앞 스텝의 응답에서 꺼낸 값(vars)
// json: 요청 본문 JSON 문자열 안에 채울 값이라 이스케이프한다 (본문 자체의 글자는 그대로)
function valueExpr(raw, ctx, row, { json = false } = {}) {
  const exprs = valueParts(raw, ctx.testData, row).map((p) => {
    if (p.lit !== undefined) return q(json && p.filled ? JSON.stringify(p.lit).slice(1, -1) : p.lit);
    const e = p.secret ? `rt.secret(${q(p.secret)})` : `String(vars[${q(p.saved)}])`;
    return json ? `JSON.stringify(${e}).slice(1, -1)` : e;
  });
  return exprs.length ? exprs.join(' + ') : '""';
}

const hasSecret = (raw, ctx, row) => raw !== undefined && valueParts(raw, ctx.testData, row).some((p) => p.secret);

function apiRequestCode(step, ctx, row) {
  const [, method, target] = String(step.value).match(/^(\w+)\s+(\S+)$/);
  const m = method.toUpperCase();
  const base = /^https?:\/\//i.test(target) ? '' : String(ctx.config.apiBaseURL || ctx.config.baseURL).replace(/\/+$/, '');
  const urlExpr = `${base ? `${q(base)} + ` : ''}${valueExpr(target, ctx, row)}`;
  const data = step.body ? `, data: JSON.parse(${valueExpr(step.body, ctx, row, { json: true })})` : '';
  // 증적(첨부)에는 비밀값이 들어간 주소를 남기지 않는다. 본문은 항상 남기지 않는다
  const shownUrl = hasSecret(target, ctx, row) ? q(target) : 'url';
  return [
    `const url = ${urlExpr};`,
    `res = await http.fetch(url, { method: ${q(m)}, headers: { 'x-autotc-trace': trace }${data}, failOnStatusCode: false });`,
    'const text = await res.text();',
    'try { body = JSON.parse(text); } catch { body = text; }',
    `await rt.attachJson(testInfo, ${q(`api-${step.no}`)}, { request: ${q(`${m} `)} + ${shownUrl}, trace, status: res.status(), body });`,
  ];
}

const NEED_RES = "expect(res, '앞에 API 요청 스텝이 필요합니다').toBeTruthy();";

function webActionCode(step, platform, ctx, row) {
  const L = () => webLocator(step.target, ctx.elements);
  const v = () => valueExpr(step.value, ctx, row);
  switch (step.action) {
    case 'open': {
      const screen = ctx.elements.screens[step.target];
      if (!screen || !screen.web) throw new HttpError(400, `${step.target} 화면에 웹 주소가 없습니다`);
      return `await page.goto(${q(screen.web)});`;
    }
    case 'input': return `await ${L()}.fill(${v()});`;
    case 'tap': return platform === 'mw' ? `await ${L()}.tap();` : `await ${L()}.click();`;
    case 'select': return `await ${L()}.selectOption(${v()});`;
    case 'hover': return `await ${L()}.hover();`;
    case 'hideKeyboard':
      return platform === 'mw'
        ? 'await page.evaluate(() => document.activeElement && document.activeElement.blur());'
        : '// PC 웹은 가상 키보드가 없어 건너뜀';
    case 'back': return 'await page.goBack();';
    case 'assertText': return `await expect(${L()}).toHaveText(${v()});`;
    case 'assertVisible': return `await expect(${L()}).toBeVisible();`;
    case 'assertHidden': return `await expect(${L()}).toBeHidden();`;
    case 'assertUrl': return `await expect(page).toHaveURL(/${escapeRegExp(resolveValue(step.value, ctx.testData, { row }))}/);`;
    case 'assertScreenshot': {
      // 데이터 행마다 화면이 다를 수 있어 기준 이미지를 행별로 둔다
      const name = `${step.value}${row ? `-${row.name.replace(/[^\w가-힣-]+/g, '_')}` : ''}.png`;
      return `await expect(${step.target ? L() : 'page'}).toHaveScreenshot(${q(name)});`;
    }
    case 'assertA11y': return `await rt.checkA11y(page, testInfo, ${q(step.value || 'serious')});`;
    case 'apiRequest': return apiRequestCode(step, ctx, row);
    case 'assertStatus': {
      const want = String(step.value);
      return [NEED_RES, /x/i.test(want)
        ? `expect(String(res.status()), '응답 코드').toMatch(/^${want[0]}\\d\\d$/);`
        : `expect(res.status(), '응답 코드').toBe(${Number(want)});`];
    }
    case 'assertJson':
      return [NEED_RES, `const [actual, expected] = rt.compareForm(rt.getPath(body, ${q(step.target)}), ${v()});`, `expect(actual, ${q(`응답 값 ${step.target}`)}).toEqual(expected);`];
    case 'assertSchema': {
      const schema = ctx.schemas && ctx.schemas[step.target];
      if (!schema) throw new HttpError(400, `data/schemas에 없는 명세: ${step.target}`);
      return [NEED_RES, `expect(rt.validateSchema(body, ${JSON.stringify(schema)}), ${q(`응답이 명세 ${step.target}와 다릅니다`)}).toEqual([]);`];
    }
    case 'saveValue':
      return [NEED_RES, `vars[${q(step.value)}] = rt.getPath(body, ${q(step.target)});`, `expect(vars[${q(step.value)}], ${q(`응답에 ${step.target} 값이 없습니다`)}).not.toBeUndefined();`];
    default: throw new HttpError(400, `웹에서 변환할 수 없는 액션: ${step.action}`);
  }
}

// 실패 시 수리 후보를 모을 요소: 이 TC가 쓰는 웹 요소의 식별자
function healTargets(steps, elements) {
  const out = {};
  for (const s of steps) {
    if (ACTIONS[s.action].target !== 'element' || !s.target) continue;
    const el = elements.elements[s.target];
    if (el && el.web) out[s.target] = el.web;
  }
  return out;
}

const isApiAction = (action) => ACTIONS[action].support === ACTIONS.apiRequest.support;

function genPlaywright(tc, platform, ctx) {
  const steps = expandSteps(tc, ctx.flows);
  for (const s of steps) {
    if (ACTIONS[s.action].support[platform] === 'unsupported') {
      throw new HttpError(400, `${PLATFORM(platform)}에서 지원하지 않는 액션: ${s.action}`);
    }
  }
  const isApi = platform === 'api';
  const usesApi = steps.some((s) => isApiAction(s.action));
  const lines = [
    `// 자동 생성 파일입니다. 직접 수정하지 말고 data/tcs/${tc.id}.json 을 고치세요.`,
    "import { test, expect } from '@playwright/test';",
    `import * as rt from ${q(RUNTIME)};`,
    '',
  ];
  const heal = isApi ? {} : healTargets(steps, ctx.elements);
  if (Object.keys(heal).length) {
    lines.push(
      '// 실패하면 요소 맵 식별자로 찾지 못한 요소와 화면의 대체 후보를 남긴다 (수리 제안용, 자동으로 고치지 않음)',
      `const HEAL = ${JSON.stringify(heal)};`,
      'test.afterEach(async ({ page }, testInfo) => {',
      `  if (testInfo.status !== testInfo.expectedStatus) await rt.collectHealData(page, testInfo, HEAL, ${q(ctx.config.testIdAttribute || 'data-testid')});`,
      '});',
      '',
    );
  }
  for (const row of rowsOf(tc)) {
    const title = `${tc.id} ${tc.title}${row ? ` [${row.name}]` : ''}`;
    lines.push(`test(${q(title)}, async ({ ${isApi ? 'request' : 'page'} }, testInfo) => {`);
    if (usesApi) {
      lines.push(
        `  const http = ${isApi ? 'request' : 'page.request'};`,
        `  const trace = \`\${process.env.AUTOTC_RUN_ID || 'local'}.${tc.id}.\${testInfo.project.name}\`;`,
        '  const vars = {};',
        '  let res;',
        '  let body;',
      );
    }
    for (const s of steps) {
      lines.push(`  await test.step(${q(stepTitle(s))}, async () => {`);
      [].concat(webActionCode(s, platform, ctx, row)).forEach((c) => lines.push(`    ${c}`));
      lines.push('  });');
    }
    lines.push('});', '');
  }
  return lines.join('\n');
}

// Maestro 선택자. 식별자가 없으면 null을 돌려주고 호출부에서 대체 방법을 쓴다.
function mobileSelector(name, platform, elements) {
  const el = elements.elements[name];
  const m = el && el[platform];
  if (!m) return null;
  if (m.id) return `id: ${q(m.id)}`;
  if (m.text) return `text: ${q(m.text)}`;
  return null;
}

// TC → Maestro 명령 목록. 명령마다 몇 번 스텝에서 나왔는지(no)와 종류(kind)를 기록해
// 실행 결과의 명령별 상태를 스텝으로 되돌려 매핑한다.
// kind: action(조작) / presence(요소 노출 확인) / value(값 확인) / meta(스텝과 무관)
// strict: 실행용. 식별자 없는 요소나 지원하지 않는 액션이 있으면 오류를 던진다
function buildMaestro(tc, platform, ctx, { strict = false, row = null } = {}) {
  const steps = expandSteps(tc, ctx.flows);
  const entries = [];
  const missing = new Set();
  const cmd = (no, kind, yaml) => entries.push({ type: 'cmd', no, kind, yaml });
  const note = (text) => entries.push({ type: 'note', text });
  const needSel = (s) => {
    const sel = mobileSelector(s.target, platform, ctx.elements);
    if (!sel) {
      missing.add(s.target);
      if (strict) throw new HttpError(400, `${s.no}번 스텝: ${s.target} 요소에 ${PLATFORM(platform)} 식별자가 없습니다 (요소 맵에서 부여)`);
    }
    return sel;
  };
  let launched = false;
  for (const s of steps) {
    const def = ACTIONS[s.action];
    if (def.support[platform] === 'unsupported') {
      if (strict) throw new HttpError(400, `${PLATFORM(platform)}에서 지원하지 않는 액션: ${s.action}`);
      note(`${s.no}. ${s.action}: ${PLATFORM(platform)}에서 지원하지 않는 액션 (이 TC는 Skipped 처리)`);
      continue;
    }
    // 비밀값은 Maestro가 실행 때 MAESTRO_ 환경변수에서 채운다 (YAML 파일에는 이름만 남음)
    const val = s.value !== undefined ? resolveValue(s.value, ctx.testData, { row, secret: (n) => `\${MAESTRO_AUTOTC_SECRET_${n}}` }) : undefined;
    note(`${s.no}. ${s.action}${s.target ? ` ${s.target}` : ''}`);
    switch (s.action) {
      case 'open': {
        const screen = ctx.elements.screens[s.target] || {};
        const link = screen[platform];
        if (!launched) {
          cmd(s.no, 'action', '- launchApp:\n    clearState: true');
          launched = true;
          if (link) cmd(s.no, 'action', `- openLink: ${q(link)}`);
        } else if (link) {
          cmd(s.no, 'action', `- openLink: ${q(link)}`);
        } else {
          if (strict) throw new HttpError(400, `${s.no}번 스텝: 앱 안에서 ${s.target} 화면으로 이동하려면 요소 맵 화면에 ${PLATFORM(platform)} 딥링크가 필요합니다`);
          note(`TODO 앱 안에서 ${s.target} 화면으로 이동하는 딥링크를 화면 정보에 지정하세요`);
        }
        break;
      }
      case 'input': {
        const sel = needSel(s);
        if (sel) cmd(s.no, 'action', `- tapOn:\n    ${sel}`);
        else note(`TODO ${s.target} 식별자 미부여`);
        cmd(s.no, 'action', '- eraseText');
        cmd(s.no, 'action', `- inputText: ${q(val)}`);
        break;
      }
      case 'tap': {
        const sel = needSel(s);
        if (sel) cmd(s.no, 'action', `- tapOn:\n    ${sel}`);
        else note(`TODO ${s.target} 식별자 미부여`);
        break;
      }
      case 'hideKeyboard': cmd(s.no, 'action', '- hideKeyboard'); break;
      case 'back': cmd(s.no, 'action', platform === 'android' ? '- back' : '- swipe:\n    start: 2%, 50%\n    end: 80%, 50%'); break;
      case 'assertText': {
        // 식별자가 있으면 "요소가 있는가"와 "문구가 맞는가"를 나눠 실패 원인을 구분한다
        const sel = mobileSelector(s.target, platform, ctx.elements);
        if (sel) {
          cmd(s.no, 'presence', `- assertVisible:\n    ${sel}`);
          cmd(s.no, 'value', `- assertVisible:\n    ${sel}\n    text: ${q(val)}`);
        } else {
          missing.add(s.target);
          note(`${s.target} 식별자 미부여로 문구로 대체`);
          cmd(s.no, 'value', `- assertVisible: ${q(val)}`);
        }
        break;
      }
      case 'assertVisible': {
        const sel = needSel(s);
        if (sel) cmd(s.no, 'presence', `- assertVisible:\n    ${sel}`);
        else note(`TODO ${s.target} 식별자 미부여`);
        break;
      }
      case 'assertHidden': {
        const sel = needSel(s);
        if (sel) cmd(s.no, 'presence', `- assertNotVisible:\n    ${sel}`);
        else note(`TODO ${s.target} 식별자 미부여`);
        break;
      }
      default:
        if (strict) throw new HttpError(400, `${s.no}번 스텝: ${s.action} 액션의 Maestro 변환 규칙이 없습니다`);
        note(`${s.action}: 변환 규칙 없음`);
    }
  }
  if (strict) cmd(null, 'meta', '- takeScreenshot: final');
  return { appId: (ctx.config[platform] || {}).appId || 'com.example.app', steps, entries, missing: [...missing] };
}

function renderMaestro(tc, built) {
  const out = [
    `# 자동 생성 파일입니다. 원본: data/tcs/${tc.id}.json`,
    `# ${tc.id} ${tc.title}`,
  ];
  if (built.missing.length) {
    out.push(`# 식별자 미부여 요소 ${built.missing.length}개: ${built.missing.join(', ')}`, '# 개발팀에 resource-id / accessibilityIdentifier 부여를 요청하세요');
  }
  out.push(`appId: ${built.appId}`, '---');
  for (const e of built.entries) out.push(e.type === 'note' ? `# ${e.text}` : e.yaml);
  return out.join('\n') + '\n';
}

// 미리보기는 데이터 행이 있으면 첫 행으로 만든다
function genMaestro(tc, platform, ctx, opts = {}) {
  return renderMaestro(tc, buildMaestro(tc, platform, ctx, { row: rowsOf(tc)[0], ...opts }));
}

// 실행용: YAML과 명령 목록(스텝 매핑용)을 함께 돌려준다. row: 데이터 행
function maestroForRun(tc, platform, ctx, row = null) {
  const built = buildMaestro(tc, platform, ctx, { strict: true, row });
  return { code: renderMaestro(tc, built), commands: built.entries.filter((e) => e.type === 'cmd'), steps: built.steps, appId: built.appId };
}

function generate(tc, platform, ctx) {
  if (platform === 'pc' || platform === 'mw' || platform === 'api') return { language: 'typescript', code: genPlaywright(tc, platform, ctx) };
  return { language: 'yaml', code: genMaestro(tc, platform, ctx) };
}

module.exports = { generate, genPlaywright, genMaestro, maestroForRun, webLocator };
