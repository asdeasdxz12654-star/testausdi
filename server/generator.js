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

function genMaestro(tc, platform, ctx) {
  const steps = expandSteps(tc, ctx.flows);
  const app = (ctx.config[platform] || {}).appId || 'com.example.app';
  const out = [
    `# 자동 생성 파일입니다. 원본: data/tcs/${tc.id}.json`,
    `# ${tc.id} ${tc.title}`,
    `appId: ${app}`,
    '---',
  ];
  let launched = false;
  const missing = new Set();
  for (const s of steps) {
    const def = ACTIONS[s.action];
    if (def.support[platform] === 'unsupported') {
      out.push(`# ${s.no}. ${s.action}: ${PLATFORM(platform)}에서 지원하지 않는 액션 (이 TC는 Skipped 처리)`);
      continue;
    }
    const sel = s.target && def.target === 'element' ? mobileSelector(s.target, platform, ctx.elements) : null;
    if (def.target === 'element' && !sel) missing.add(s.target);
    const val = s.value !== undefined ? resolveValue(s.value, ctx.testData) : undefined;
    out.push(`# ${s.no}. ${s.action}${s.target ? ` ${s.target}` : ''}`);
    switch (s.action) {
      case 'open':
        if (!launched) { out.push('- launchApp:', '    clearState: true'); launched = true; }
        else out.push(`# 앱 안에서 ${s.target} 화면으로 이동하는 방법(딥링크 등)을 지정해야 합니다`);
        break;
      case 'input':
        out.push(sel ? `- tapOn:\n    ${sel}` : `# TODO ${s.target} 식별자 미부여`, `- inputText: ${q(val)}`);
        break;
      case 'tap':
        out.push(sel ? `- tapOn:\n    ${sel}` : `# TODO ${s.target} 식별자 미부여`);
        break;
      case 'hideKeyboard': out.push('- hideKeyboard'); break;
      case 'back': out.push(platform === 'android' ? '- back' : '- swipe:\n    start: 0%, 50%\n    end: 80%, 50%'); break;
      case 'assertText':
        out.push(sel ? `- assertVisible:\n    ${sel}\n    text: ${q(val)}` : `- assertVisible: ${q(val)}   # ${s.target} 식별자 미부여로 문구로 대체`);
        break;
      case 'assertVisible':
        out.push(sel ? `- assertVisible:\n    ${sel}` : `# TODO ${s.target} 식별자 미부여`);
        break;
      case 'assertHidden':
        out.push(sel ? `- assertNotVisible:\n    ${sel}` : `# TODO ${s.target} 식별자 미부여`);
        break;
      default:
        out.push(`# ${s.action}: 변환 규칙 없음`);
    }
  }
  if (missing.size) {
    out.splice(4, 0, `# 식별자 미부여 요소 ${missing.size}개: ${[...missing].join(', ')}`, '# 개발팀에 resource-id / accessibilityIdentifier 부여를 요청하세요');
  }
  return out.join('\n') + '\n';
}

function generate(tc, platform, ctx) {
  if (platform === 'pc' || platform === 'mw') return { language: 'typescript', code: genPlaywright(tc, platform, ctx) };
  return { language: 'yaml', code: genMaestro(tc, platform, ctx) };
}

module.exports = { generate, genPlaywright, genMaestro, webLocator };
