// 요소 수리 제안 (셀프힐링을 사람 승인 방식으로).
// 실패한 웹 TC에서 요소 맵 식별자로 찾지 못한 요소마다, 실패 시점 화면의 후보 중 가장 비슷한 것을 고른다.
// 자동으로 고쳐서 통과시키지 않는다: 기대 요소를 다른 요소로 바꿔 통과시키면 결함을 숨길 수 있기 때문이다.
// 다른 상품 버튼처럼 앞부분만 같은 식별자(0.7 안팎)는 제안하지 않는다
const MIN_SCORE = 0.75;

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

function bigrams(s) {
  const t = norm(s).replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// 다이스 계수 (0~1)
function dice(x, y) {
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

// 줄임말: 첫 글자가 같고 짧은 쪽 글자가 긴 쪽에 순서대로 다 있으면 (btn ↔ button, pw ↔ password)
function abbreviates(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (!s || s[0] !== l[0]) return false;
  let i = 0;
  for (const ch of l) if (ch === s[i]) i += 1;
  return i === s.length;
}

// 단어별 점수: 같으면 1, 줄임말이면 0.8, 아니면 다이스. 단어 수가 다르면 긴 쪽 기준으로 나눈다
function tokenScore(x, y) {
  const A = x.split(' ');
  const B = y.split(' ');
  const best = A.map((t) => Math.max(...B.map((u) => (t === u ? 1 : abbreviates(t, u) ? 0.8 : dice(t, u)))));
  return best.reduce((s, v) => s + v, 0) / Math.max(A.length, B.length);
}

// 식별자·이름의 비슷한 정도 (0~1)
function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return Math.max(dice(x, y), tokenScore(x, y));
}

const ROLE_TAGS = { button: ['button'], link: ['a'], textbox: ['input', 'textarea'], combobox: ['select'], checkbox: ['input'] };

// 요소 하나의 식별자와 후보 하나를 비교한다. 같은 방식(testId끼리, 이름끼리)으로만 비교한다
function scoreCandidate(web, c) {
  if (web.testId) {
    return { score: c.testId ? similarity(web.testId, c.testId) : 0, by: 'testId' };
  }
  if (web.role) {
    const tagOk = !ROLE_TAGS[web.role] || ROLE_TAGS[web.role].includes(c.tag) || c.role === web.role;
    return { score: tagOk ? similarity(web.name, c.text) : 0, by: 'name' };
  }
  if (web.text) return { score: similarity(web.text, c.text), by: 'text' };
  return { score: 0, by: null };
}

function proposal(web, c, by) {
  if (by === 'testId') return { testId: c.testId };
  if (by === 'name') return { role: web.role, name: c.text };
  return { text: c.text };
}

// data: runtime.collectHealData가 남긴 { url, missing, candidates }
// only: 실패한 스텝의 요소. 다른 화면의 요소는 지금 화면에 없는 게 정상이라 제안 대상에서 뺀다
function suggest(data, elements, only) {
  if (!data || !Array.isArray(data.missing)) return [];
  const used = new Set(Object.values(elements.elements).map((e) => e.web && e.web.testId).filter(Boolean));
  const out = [];
  for (const name of data.missing.filter((n) => !only || n === only)) {
    const el = elements.elements[name];
    if (!el || !el.web) continue;
    let best = null;
    for (const c of data.candidates || []) {
      const { score, by } = scoreCandidate(el.web, c);
      // 이미 다른 요소가 쓰는 testId는 후보에서 뺀다 (다른 요소를 가리키게 될 수 있음)
      if (by === 'testId' && used.has(c.testId)) continue;
      if (!best || score > best.score) best = { score, by, c };
    }
    if (!best || best.score < MIN_SCORE) {
      out.push({ element: name, label: el.label, current: el.web, suggestion: null, score: best ? Math.round(best.score * 100) / 100 : 0, reason: '비슷한 후보를 찾지 못했습니다. 화면이 바뀌었거나 요소가 사라졌을 수 있어 제품 확인이 필요합니다' });
      continue;
    }
    const { c, by } = best;
    out.push({
      element: name,
      label: el.label,
      current: el.web,
      suggestion: { ...proposal(el.web, c, by), ...(Number.isInteger(el.web.nth) ? { nth: el.web.nth } : {}) },
      score: Math.round(best.score * 100) / 100,
      candidate: { tag: c.tag, text: c.text, testId: c.testId },
      reason: `${by === 'testId' ? '식별자가' : '이름이'} ${Math.round(best.score * 100)}% 비슷한 ${c.tag}${c.text ? ` "${c.text}"` : ''}`,
    });
  }
  return out;
}

module.exports = { similarity, suggest, MIN_SCORE };
