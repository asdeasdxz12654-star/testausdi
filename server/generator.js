// TC JSON → 엔진별 스크립트 변환. PC 웹·MW는 Playwright, 안드로이드·아이폰은 Maestro YAML.
const { ACTIONS, PLATFORM_LABELS } = require('./actions');
const { expandSteps, resolveValue, stepTitle } = require('./tc');
const { HttpError } = require('./store');

const q = (s) => JSON.stringify(String(s));
const PLATFORM = (p) => PLATFORM_LABELS[p] || p;

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

function webActionCode(step, platform, ctx) {
  const L = () => webLocator(step.target, ctx.elements);
  const v = () => q(resolveValue(step.value, ctx.testData));
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
    case 'assertUrl': return `await expect(page).toHaveURL(/${escapeRegExp(resolveValue(step.value, ctx.testData))}/);`;
    default: throw new HttpError(400, `웹에서 변환할 수 없는 액션: ${step.action}`);
  }
}

function genPlaywright(tc, platform, ctx) {
  const steps = expandSteps(tc, ctx.flows);
  const lines = [
    `// 자동 생성 파일입니다. 직접 수정하지 말고 data/tcs/${tc.id}.json 을 고치세요.`,
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${q(`${tc.id} ${tc.title}`)}, async ({ page }) => {`,
  ];
  for (const s of steps) {
    if (ACTIONS[s.action].support[platform] === 'unsupported') {
      throw new HttpError(400, `${PLATFORM(platform)}에서 지원하지 않는 액션: ${s.action}`);
    }
    lines.push(`  await test.step(${q(stepTitle(s))}, async () => {`);
    lines.push(`    ${webActionCode(s, platform, ctx)}`);
    lines.push('  });');
  }
  lines.push('});', '');
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
function buildMaestro(tc, platform, ctx, { strict = false } = {}) {
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
    const val = s.value !== undefined ? resolveValue(s.value, ctx.testData) : undefined;
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

function genMaestro(tc, platform, ctx, opts) {
  return renderMaestro(tc, buildMaestro(tc, platform, ctx, opts));
}

// 실행용: YAML과 명령 목록(스텝 매핑용)을 함께 돌려준다
function maestroForRun(tc, platform, ctx) {
  const built = buildMaestro(tc, platform, ctx, { strict: true });
  return { code: renderMaestro(tc, built), commands: built.entries.filter((e) => e.type === 'cmd'), steps: built.steps, appId: built.appId };
}

function generate(tc, platform, ctx) {
  if (platform === 'pc' || platform === 'mw') return { language: 'typescript', code: genPlaywright(tc, platform, ctx) };
  return { language: 'yaml', code: genMaestro(tc, platform, ctx) };
}

module.exports = { generate, genPlaywright, genMaestro, maestroForRun, webLocator };
