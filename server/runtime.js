// 생성된 Playwright 스크립트가 실행 중에 쓰는 도우미. 생성 코드가 이 파일을 절대 경로로 불러온다.
// API 응답 확인(JSON 경로·스키마), 접근성 검사, 실패 시 요소 수리 후보 수집.

// "data.items[0].id", "[0].title" 형식의 경로로 값을 꺼낸다. 없으면 undefined
function getPath(obj, path) {
  const keys = [];
  String(path).replace(/\[(\d+)\]|([^.[\]]+)/g, (_, idx, key) => { keys.push(idx !== undefined ? Number(idx) : key); return ''; });
  return keys.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

// 기대값 문자열과 실제 값을 expect(...).toEqual로 비교할 수 있는 [실제, 기대] 쌍으로 만든다.
// 실패 메시지의 Received에 실제 응답 값이 그대로 보이게 하려는 것
// "*" 는 값이 있기만 하면 통과, JSON으로 읽히는 값(숫자, true, null, {…})은 값 그대로, 그 외는 문자열로 비교
function compareForm(actual, expected) {
  const raw = String(expected);
  if (raw === '*') return [actual === undefined ? '(값 없음)' : '(값 있음)', '(값 있음)'];
  let want = raw;
  try { want = JSON.parse(raw); } catch { /* 따옴표 없는 문자열 */ }
  if (typeof want === 'string') return [actual === undefined ? undefined : actual === null ? null : String(actual), want];
  return [actual, want];
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

// JSON Schema의 자주 쓰는 부분만 지원한다:
// type, required, properties, additionalProperties(false), items, enum, const, minimum, maximum, minLength, maxLength, pattern, minItems, maxItems
function validateSchema(value, schema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = [].concat(schema.type);
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) { errors.push(`${at}: 타입이 ${types.join('|')}이어야 하는데 ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)}은(는) 허용 값(${schema.enum.map((e) => JSON.stringify(e)).join(', ')})이 아님`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: ${JSON.stringify(schema.const)}이어야 함`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${schema.minimum} 이상이어야 함 (실제 ${value})`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${schema.maximum} 이하여야 함 (실제 ${value})`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: 길이 ${schema.minLength} 이상이어야 함`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: 길이 ${schema.maxLength} 이하여야 함`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: 형식(${schema.pattern})과 맞지 않음`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: 항목 ${schema.minItems}개 이상이어야 함 (실제 ${value.length})`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: 항목 ${schema.maxItems}개 이하여야 함`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}.${k}: 필수 항목 없음`);
    const props = schema.properties || {};
    for (const [k, sub] of Object.entries(props)) if (k in value) errors.push(...validateSchema(value[k], sub, `${at}.${k}`));
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in props)) errors.push(`${at}.${k}: 명세에 없는 항목`);
    }
  }
  return errors;
}

// 비밀값은 실행할 때 환경변수로만 받는다. 생성된 스크립트 파일에는 값이 남지 않는다
function secret(name) {
  const v = process.env[`AUTOTC_SECRET_${name}`];
  if (v === undefined) throw new Error(`비밀값 ${name}이(가) 없습니다 (설정 → 비밀값 또는 환경변수 ${name})`);
  return v;
}

// 증적은 파일로 남겨 첨부한다 (AutoTC 리포터는 파일 첨부만 실행 기록에 옮긴다)
async function attachJson(testInfo, name, data) {
  const file = testInfo.outputPath(`${name}.json`);
  require('fs').writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  await testInfo.attach(name, { path: file, contentType: 'application/json' });
}

const IMPACT = ['minor', 'moderate', 'serious', 'critical'];
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// axe-core로 현재 화면을 검사한다. level 이상의 위반만 실패로 보고, 전체 결과는 첨부로 남긴다
async function checkA11y(page, testInfo, level = 'serious') {
  const { default: AxeBuilder } = require('@axe-core/playwright');
  const min = Math.max(0, IMPACT.indexOf(level));
  const res = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  const bad = res.violations.filter((v) => IMPACT.indexOf(v.impact) >= min);
  const report = res.violations.map((v) => ({
    id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags.filter((t) => t.startsWith('wcag')),
    nodes: v.nodes.slice(0, 10).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), summary: n.failureSummary })),
    count: v.nodes.length,
  }));
  await attachJson(testInfo, 'a11y', { url: page.url(), level, total: report.length, violations: report });
  if (bad.length) {
    throw new Error(`접근성 위반 ${bad.length}종 (${level} 이상): ${bad.map((v) => `${v.id}[${v.impact}] ${v.nodes.length}곳`).join(', ')}`);
  }
}

// 실패한 TC에서 요소 맵 식별자로 찾지 못한 요소와, 화면에 있는 대체 후보를 모은다.
// 결과는 첨부(autotc-heal)로 남기고, 서버가 유사도를 계산해 사람에게 수리를 제안한다. 자동으로 고치지 않는다
async function collectHealData(page, testInfo, elements, testIdAttribute) {
  try {
    if (page.isClosed()) return;
    const missing = [];
    for (const [name, w] of Object.entries(elements)) {
      let loc;
      if (w.testId) loc = page.locator(`[${testIdAttribute}="${String(w.testId).replace(/"/g, '\\"')}"]`);
      else if (w.role) loc = page.getByRole(w.role, w.name ? { name: w.name } : undefined);
      else if (w.text) loc = page.getByText(w.text, { exact: true });
      else if (w.css) loc = page.locator(w.css);
      else continue;
      if ((await loc.count()) === 0) missing.push(name);
    }
    if (!missing.length) return;
    const candidates = await page.evaluate((attr) => {
      const out = [];
      const nodes = document.querySelectorAll(`[${attr}], button, a[href], input, select, textarea, [role]`);
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        out.push({
          testId: el.getAttribute(attr),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || null,
          type: el.getAttribute('type') || null,
          text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
          id: el.id || null,
        });
        if (out.length >= 300) break;
      }
      return out;
    }, testIdAttribute);
    await attachJson(testInfo, 'autotc-heal', { url: page.url(), missing, candidates });
  } catch {
    // 수리 후보 수집 실패는 판정에 영향을 주지 않는다
  }
}

module.exports = { getPath, compareForm, validateSchema, secret, attachJson, checkA11y, collectHealData, IMPACT };
