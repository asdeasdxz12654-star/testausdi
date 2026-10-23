// AutoTC 콘솔. 빌드 없이 도는 단일 스크립트. 화면은 hash 경로로 나눈다 (#dash, #tcs/ID, #result/RUN/KEY ...)
'use strict';

const S = {
  meta: null, config: null, tcs: [], elements: null, flows: {}, runs: [], issues: [],
  runCache: {}, polling: null, draft: null, draftId: null, dirty: false, preview: null, previewTab: 'pc',
  dashRunId: null, dashFilter: 'problem', issueType: 'ALL', hideClosed: true, devices: null,
};

// ---------- 공통 ----------
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, isErr) {
  const t = h('div', { class: `toast${isErr ? ' err' : ''}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2600);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; }
}

const app = () => document.getElementById('app');
const PL = (p) => (S.meta ? S.meta.platformLabels[p] : p);
const plat = (p, label) => h('span', { class: `plat p-${p}` }, label || PL(p));
const pill = (status) => h('span', { class: `pill s-${status}` }, status);
const typePill = (t) => h('span', { class: `pill t-${t}` }, t);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
const fmtDur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${(ms / 1000).toFixed(1)}초`);
const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`);
const clsLabel = (c) => (c ? S.meta.classifications[c] || c : '-');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); } catch { toast('복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요', true); }
}

function confirmButton(label, onConfirm, cls = 'btn danger') {
  const b = h('button', { class: cls, type: 'button' }, label);
  let armed = false;
  b.addEventListener('click', () => {
    if (armed) { onConfirm(); return; }
    armed = true;
    b.textContent = '한 번 더 누르면 실행';
    setTimeout(() => { armed = false; b.textContent = label; }, 3000);
  });
  return b;
}

// ---------- 데이터 ----------
async function loadAll() {
  const [meta, config, tcs, elements, flows, runs, issues, schemas] = await Promise.all([
    api('GET', '/api/meta'), api('GET', '/api/config'), api('GET', '/api/tcs'), api('GET', '/api/elements'),
    api('GET', '/api/flows'), api('GET', '/api/runs'), api('GET', '/api/issues'), api('GET', '/api/schemas'),
  ]);
  Object.assign(S, { meta, config, tcs, elements, flows, runs, issues, schemas });
  document.getElementById('projName').textContent = `${config.project} · ${config.env} · v${meta.version}`;
  const running = runs.find((r) => r.status === 'running');
  if (running) startPolling(running.id);
}

async function getRun(id, fresh) {
  if (!fresh && S.runCache[id] && S.runCache[id].status !== 'running') return S.runCache[id];
  const run = await api('GET', `/api/runs/${encodeURIComponent(id)}`);
  S.runCache[id] = run;
  return run;
}

function startPolling(runId) {
  clearInterval(S.polling);
  const tick = async () => {
    const run = await getRun(runId, true).catch(() => null);
    renderRunState(run);
    if (!run || run.status !== 'running') {
      clearInterval(S.polling);
      S.polling = null;
      S.runs = await api('GET', '/api/runs');
      S.issues = await api('GET', '/api/issues');
      if (run) toast(run.status === 'done' ? `실행 완료: ${run.label}` : `실행 오류: ${run.error || ''}`, run.status !== 'done');
      S.dashRunId = runId;
    }
    if (currentView() === 'dash') renderDash();
  };
  S.polling = setInterval(tick, 1500);
  tick();
}

function renderRunState(run) {
  const el = document.getElementById('runState');
  el.replaceChildren();
  if (run && run.status === 'running') el.append(h('span', { class: 'dot' }), `${run.label} · ${run.phase || '실행 중'}`);
}

async function startRun(body) {
  const run = await guard(() => api('POST', '/api/runs', body));
  if (!run) return;
  toast(`실행 시작: ${run.label}`);
  S.dashRunId = run.id;
  S.runs = await api('GET', '/api/runs');
  startPolling(run.id);
  if (currentView() !== 'dash') location.hash = '#dash';
}

// ---------- 라우팅 ----------
function currentView() {
  return (location.hash.slice(1).split('/')[0]) || 'dash';
}

async function route() {
  const [view, ...rest] = location.hash.slice(1).split('/').map(decodeURIComponent);
  const v = view || 'dash';
  window.onbeforeunload = null;
  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.view === v || (v === 'result' && a.dataset.view === 'dash') || (v === 'import' && a.dataset.view === 'tcs');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (v !== 'mapping') { clearInterval(S.mapPoll); S.mapPoll = null; }
  const views = { dash: renderDash, tcs: () => renderTcs(rest[0]), import: renderImport, mapping: () => renderMapping(rest[0]), generate: () => renderGenerate(rest[0]), settings: renderSettings, elements: renderElements, devices: renderDevices, issues: renderIssues, metrics: renderMetrics, result: () => renderResult(rest[0], rest[1]) };
  await (views[v] || renderDash)();
}

window.addEventListener('hashchange', () => {
  if (S.dirty && currentView() !== 'tcs') {
    S.dirty = false;
    toast('저장하지 않은 TC 변경 내용을 버렸습니다');
  }
  route();
});

// ---------- 실행 현황 ----------
async function renderDash() {
  const root = app();
  const running = S.runs.find((r) => r.status === 'running');
  const runId = S.dashRunId || (S.runs.find((r) => r.status !== 'running') || {}).id;
  const run = runId ? await getRun(runId).catch(() => null) : null;
  const liveRun = running ? S.runCache[running.id] : null;
  root.replaceChildren(...[
    newRunCard(!!running),
    liveRun ? liveCard(liveRun) : null,
    run && run.status !== 'running' ? runSummary(run) : (!running ? h('div', { class: 'empty' }, '아직 실행 기록이 없습니다. 위에서 플랫폼을 고르고 실행을 눌러 첫 회귀를 돌려보세요.') : null),
  ].filter(Boolean));
}

function newRunCard(disabled) {
  const tags = [...new Set(S.tcs.flatMap((t) => t.tags || []))].sort();
  const form = h('form', { class: 'stack' });
  const platRow = h('div', { class: 'row' }, h('span', { class: 'sub' }, '플랫폼'),
    S.meta.platforms.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'platform', value: p, checked: p === 'pc' || p === 'mw' || p === 'api' }), plat(p))));
  const hasVisual = S.tcs.some((t) => t.steps.some((s) => s.action === 'assertScreenshot'));
  const suite = h('select', { name: 'suite', id: 'suiteSel' }, h('option', { value: '' }, `전체 자동화 TC (${S.tcs.filter((t) => t.automation !== '수동 유지').length}건)`),
    tags.map((t) => h('option', { value: t }, `@${t} (${S.tcs.filter((x) => (x.tags || []).includes(t)).length}건)`)));
  form.append(h('div', { class: 'row between' }, h('h2', {}, '새 실행'), h('span', { class: 'sub' }, `대상 ${S.config.baseURL}`)),
    platRow,
    h('div', { class: 'row' }, h('span', { class: 'sub' }, '스위트'), suite, h('button', { class: 'btn primary', type: 'submit', disabled }, disabled ? '실행 중…' : '실행')),
    hasVisual ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'updateBaselines' }), '화면 비교 기준 이미지를 이번 화면으로 갱신 (의도한 디자인 변경을 반영할 때만)') : null);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const platforms = [...form.querySelectorAll('input[name=platform]:checked')].map((i) => i.value);
    const tag = form.querySelector('select[name=suite]').value;
    const ub = form.querySelector('input[name=updateBaselines]');
    startRun({ platforms, tags: tag ? [tag] : undefined, updateBaselines: !!(ub && ub.checked), label: ub && ub.checked ? '기준 이미지 갱신' : undefined });
  });
  return h('section', { class: 'card' }, form);
}

function liveCard(run) {
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, `${run.label} 실행 중`), h('span', { class: 'sub' }, `${fmtTime(run.startedAt)} 시작 · ${run.phase || ''}`)),
    h('pre', { class: 'log' }, run.log.slice(-40).join('\n')));
}

function runSummary(run) {
  const sm = run.summary;
  const runSel = h('select', { 'aria-label': '실행 기록 선택', onchange: (e) => { S.dashRunId = e.target.value; renderDash(); } },
    S.runs.filter((r) => r.status !== 'running').map((r) => h('option', { value: r.id, selected: r.id === run.id }, `${r.id} · ${r.label}`)));
  if (run.status === 'error' || !sm) {
    return h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, run.label), runSel),
      h('div', { class: 'errbox' }, `실행이 오류로 끝났습니다: ${run.error || '알 수 없는 오류'}`), h('pre', { class: 'log' }, run.log.join('\n')));
  }
  const c = sm.counts;
  const dur = run.finishedAt ? fmtDur(new Date(run.finishedAt) - new Date(run.startedAt)) : '-';
  const failed = run.results.filter((r) => r.status === 'Fail');
  const header = h('div', { class: 'row between' },
    h('div', {}, h('h2', {}, `${run.label}`), h('div', { class: 'sub' }, `${fmtTime(run.startedAt)} 시작 · 소요 ${dur} · TC ${run.tcIds.length}건 · ${run.platforms.map(PL).join(', ')}`)),
    h('div', { class: 'row' }, runSel,
      failed.length ? h('button', { class: 'btn', type: 'button', onclick: () => startRun({ tcIds: [...new Set(failed.map((r) => r.tcId))], platforms: [...new Set(failed.map((r) => r.platform))], label: `실패 재실행 (${run.id})` }) }, `실패 ${failed.length}건 재실행`) : null,
      run.htmlReport ? h('a', { class: 'btn', href: run.htmlReport, target: '_blank', rel: 'noopener' }, 'Playwright 리포트') : null));

  const kpis = h('div', { class: 'kpis' },
    [['Pass', c.Pass, 'ok'], ['Fail', c.Fail, 'bad'], ['Flaky', c.Flaky, 'warn'], ['Blocked · Skipped', c.Blocked + c.Skipped, ''], ['통과율', pct(sm.passRate), '']]
      .map(([t, n, cls]) => h('div', { class: 'kpi' }, h('div', { class: `n ${cls}` }, n), h('div', { class: 't' }, t))));

  const verdict = h('div', { class: 'stack' },
    h('div', { class: `verdict ${sm.releasable ? 'yes' : 'no'}` }, sm.releasable ? '종료 기준 충족' : '종료 기준 미충족'),
    h('ul', { class: 'criteria' }, sm.exit.map((e) => h('li', {}, h('span', {}, h('span', { class: e.ok ? 'ok' : 'bad' }, e.ok ? '✓ ' : '✕ '), e.label),
      h('span', { class: 'sub' }, `${e.percent ? pct(e.value) : e.value} / 기준 ${e.percent ? pct(e.max) : `${e.max} 이하`}`)))),
    sm.quarantined ? h('div', { class: 'sub' }, `격리된 Flaky TC ${sm.quarantined}건은 집계에서 뺐습니다`) : null,
    sm.newBaselines ? h('div', { class: 'sub warn' }, `화면 비교 기준 이미지를 새로 저장한 결과 ${sm.newBaselines}건: 결과 상세에서 화면을 확인하세요`) : null);

  const bars = h('div', {}, h('h3', {}, '플랫폼별 결과'), run.platforms.map((p) => {
    const b = sm.byPlatform[p];
    const total = Object.values(b).reduce((a, x) => a + x, 0) || 1;
    return h('div', { class: 'platrow' }, plat(p),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${PL(p)} Pass ${b.Pass}, Fail ${b.Fail}, Flaky ${b.Flaky}, Blocked ${b.Blocked}, Skipped ${b.Skipped}` },
        ['Pass', 'Fail', 'Flaky', 'Blocked', 'Skipped'].map((s) => (b[s] ? h('i', { class: s, style: `width:${(b[s] / total) * 100}%` }) : null))),
      h('span', { class: 'num' }, b.Blocked && b.Blocked === total ? 'Blocked' : `${b.Pass + b.Flaky}/${b.Pass + b.Flaky + b.Fail} 통과`));
  }));

  const filters = { problem: '문제만', all: '전체', Blocked: 'Blocked·Skipped' };
  const rows = run.results.filter((r) => S.dashFilter === 'all' || (S.dashFilter === 'problem' ? ['Fail', 'Flaky'].includes(r.status) : ['Blocked', 'Skipped'].includes(r.status)));
  const table = h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('h3', {}, '결과'), h('div', { class: 'chips' }, Object.entries(filters).map(([k, label]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.dashFilter === k), onclick: () => { S.dashFilter = k; renderDash(); } }, label)))),
    rows.length ? h('div', { class: 'tbl' }, h('table', {},
      h('thead', {}, h('tr', {}, ['TC', '플랫폼', '상태', '실패 스텝 / 사유', '분류', '이슈'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: 'clickable', tabindex: '0', onclick: () => { location.hash = `#result/${run.id}/${encodeURIComponent(r.key)}`; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#result/${run.id}/${encodeURIComponent(r.key)}`; } },
        h('td', {}, h('div', { class: 'mono' }, r.tcId), h('div', { class: 'sub' }, r.title)),
        h('td', {}, plat(r.platform), h('div', { class: 'sub' }, r.device)),
        h('td', {}, pill(r.status), r.quarantined ? h('div', { class: 'sub warn' }, '격리') : null),
        h('td', {}, r.failedStep ? r.failedStep.title : (r.reason || '-'), r.failedRow ? h('div', { class: 'sub' }, `데이터 행: ${r.failedRow}`) : null),
        h('td', {}, r.classification.confirmed ? h('span', {}, clsLabel(r.classification.confirmed), h('span', { class: 'sub' }, ' (확정)')) : clsLabel(r.classification.proposed)),
        h('td', {}, r.issueId ? h('span', {}, h('span', { class: 'mono' }, r.issueId), r.knownIssue ? h('div', { class: 'sub' }, '기존 이슈') : h('div', { class: 'sub' }, '신규')) : '-'))))))
      : h('div', { class: 'empty' }, S.dashFilter === 'problem' ? 'Fail·Flaky 결과가 없습니다' : '해당하는 결과가 없습니다'));

  return h('section', { class: 'card stack' }, header, kpis, h('div', { class: 'grid2' }, verdict, bars), table);
}

// ---------- 결과 상세 ----------
async function renderResult(runId, key) {
  const run = await guard(() => getRun(runId));
  if (!run) { app().replaceChildren(h('div', { class: 'empty' }, '실행 기록을 찾을 수 없습니다')); return; }
  const r = run.results.find((x) => x.key === key);
  if (!r) { app().replaceChildren(h('div', { class: 'empty' }, '결과를 찾을 수 없습니다')); return; }
  const others = run.results.filter((o) => o.tcId === r.tcId && o.key !== r.key);
  const basis = r.status === 'Flaky' ? r.attempts.find((a) => a.status !== 'passed') : r.attempts[r.attempts.length - 1];
  const isDiffImg = (a) => /-(expected|actual|diff)\.png$/.test(a.name);
  const shot = r.attachments.find((a) => a.name === 'screenshot') || r.attachments.find((a) => a.contentType === 'image/png' && !isDiffImg(a));
  const diffImgs = r.attachments.filter(isDiffImg);
  const apiFiles = r.attachments.filter((a) => /^api-\d+$/.test(a.name));
  const a11yFile = r.attachments.find((a) => a.name === 'a11y');
  const video = r.attachments.find((a) => a.contentType && a.contentType.startsWith('video/'));
  const trace = r.attachments.find((a) => a.name === 'trace');
  const ctxFile = r.attachments.find((a) => a.name === 'error-context');
  const logFiles = r.attachments.filter((a) => a.contentType === 'text/plain');

  const head = h('section', { class: 'card stack' },
    h('div', {}, h('a', { href: '#dash', onclick: () => { S.dashRunId = run.id; } }, `← ${run.id} ${run.label}`)),
    h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'mono sub' }, `${r.tcId} · ${r.priority}`), h('h2', {}, r.title), h('div', { class: 'sub row' }, plat(r.platform), r.device, r.durationMs ? `· ${fmtDur(r.durationMs)}` : null, r.attempts.length ? `· 시도 ${r.attempts.length}회` : null)),
      h('div', { class: 'row' }, pill(r.status), r.issueId ? h('a', { class: 'btn', href: '#issues' }, `${r.issueId}${r.knownIssue ? ' (기존 이슈)' : ''}`) : null,
        h('button', { class: 'btn', type: 'button', onclick: () => startRun({ tcIds: [r.tcId], platforms: [r.platform], label: `재실행 ${r.tcId}` }) }, '이 TC 재실행'),
        h('a', { class: 'btn', href: `#tcs/${encodeURIComponent(r.tcId)}` }, 'TC 열기'))),
    r.reason ? h('div', { class: r.status === 'Blocked' ? 'errbox' : 'notice' }, r.reason) : null,
    r.trace ? h('div', { class: 'sub' }, '추적 ID ', h('span', { class: 'mono' }, r.trace), ' · API 요청 헤더 x-autotc-trace로 보냅니다. 서버 로그에서 이 값으로 찾으세요') : null);

  const left = h('div', { class: 'stack' });
  if (r.rows) {
    left.append(h('section', { class: 'card stack' }, h('h3', {}, `데이터 행 ${r.rows.length}개`),
      h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['행', '결과', '시간'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.rows.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, pill(x.status)), h('td', { class: 'num' }, fmtDur(x.durationMs))))))),
      r.failedRow ? h('div', { class: 'sub' }, `아래 스텝·오류·증적은 "${r.failedRow}" 행 기준입니다`) : null));
  }
  if (r.heal && r.heal.length) left.append(healCard(run, r, () => renderResult(runId, key)));
  if (basis) {
    const failedNo = r.failedStep && r.failedStep.no;
    left.append(h('section', { class: 'card' }, h('h3', {}, r.status === 'Flaky' ? '첫 실패 시도의 스텝' : '스텝'),
      h('ol', { class: 'steps' }, basis.steps.map((s) => {
        const bad = !!s.error;
        return h('li', { class: bad ? 'failed' : '' }, h('span', { class: `mark ${bad ? 'bad' : 'ok'}` }, bad ? '✕' : '✓'), h('span', {}, s.title), h('span', { class: 'ms' }, `${(s.duration / 1000).toFixed(1)}s`));
      })),
      failedNo ? h('div', { class: 'sub', style: 'margin-top:6px' }, `${failedNo}번 스텝 이후는 실행되지 않았습니다`) : null));
  }
  if (r.error) left.append(h('section', { class: 'card stack' }, h('h3', {}, `오류 · ${r.errorType}`), h('pre', {}, r.error.split('\n').slice(0, 18).join('\n'))));

  if (r.status === 'Fail' || r.status === 'Flaky') {
    const confirmed = r.classification.confirmed;
    left.append(h('section', { class: 'card stack' },
      h('h3', {}, '실패 분류'),
      h('div', { class: 'sub' }, `제안: ${clsLabel(r.classification.proposed)}${confirmed ? ` · QA 확정: ${clsLabel(confirmed)}` : ' · 아직 확정하지 않음'}`),
      h('div', { class: 'chips' }, Object.entries(S.meta.classifications).map(([k, label]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String((confirmed || r.classification.proposed) === k),
        onclick: async () => {
          const updated = await guard(() => api('PUT', `/api/runs/${run.id}/results/${encodeURIComponent(r.key)}`, { classification: k }));
          if (!updated) return;
          S.runCache[run.id] = updated;
          S.issues = await api('GET', '/api/issues');
          toast(`분류를 "${label}"(으)로 확정했습니다`);
          renderResult(runId, key);
        },
      }, label))),
      h('div', { class: 'sub' }, '확정하면 연결된 이슈의 유형도 함께 바뀝니다 (제품 결함 → BUG, 스크립트 → AUT, 환경 → ENV, Flaky → FLK)')));
    if (r.defectDraft) {
      left.append(h('section', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h3', {}, '결함 초안'), h('button', { class: 'btn primary', type: 'button', onclick: () => copyText(r.defectDraft) }, '결함 초안 복사')),
        h('pre', { style: 'white-space:pre-wrap' }, r.defectDraft)));
    }
  }

  const right = h('div', { class: 'stack' });
  if (diffImgs.length) {
    const label = { expected: '기준', actual: '이번 실행', diff: '차이' };
    right.append(h('section', { class: 'card stack' }, h('h3', {}, '화면 비교'),
      h('div', { class: 'diffs' }, diffImgs.map((a) => h('figure', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, h('img', { src: a.url, alt: a.name })), h('figcaption', {}, label[a.name.match(/-(expected|actual|diff)\.png$/)[1]])))),
      r.baselineCreated ? h('div', { class: 'sub warn' }, '기준 이미지를 이번에 처음 저장했습니다. 화면이 의도한 모습이면 data/baselines를 Git에 커밋하세요') : null));
  }
  if (a11yFile) right.append(a11yCard(a11yFile));
  if (apiFiles.length) right.append(apiCard(apiFiles));
  if (shot) right.append(h('section', { class: 'card stack' }, h('h3', {}, r.status === 'Pass' ? '마지막 화면' : '실패 시점 화면'), h('a', { href: shot.url, target: '_blank', rel: 'noopener' }, h('img', { class: 'shot', src: shot.url, alt: `${r.tcId} ${PL(r.platform)} 스크린샷` }))));
  if (video || trace || ctxFile || logFiles.length) {
    right.append(h('section', { class: 'card stack' }, h('h3', {}, '증적'),
      video ? h('video', { src: video.url, controls: true, style: 'width:100%;border-radius:8px' }) : null,
      h('div', { class: 'row' },
        video ? h('a', { class: 'btn small', href: video.url, target: '_blank', rel: 'noopener' }, '영상 열기') : null,
        ctxFile ? h('a', { class: 'btn small', href: ctxFile.url, target: '_blank', rel: 'noopener' }, '오류 시점 화면 구조') : null,
        logFiles.map((a) => h('a', { class: 'btn small', href: a.url, target: '_blank', rel: 'noopener' }, a.name === 'logcat' ? 'logcat 로그' : a.name === 'maestro' ? 'Maestro 로그' : a.name)),
        trace ? h('a', { class: 'btn small', href: trace.url }, '트레이스 받기') : null),
      trace ? h('div', { class: 'sub' }, '트레이스는 https://trace.playwright.dev 에 끌어다 놓거나 npx playwright show-trace 로 엽니다') : null));
  }
  if (others.length) {
    right.append(h('section', { class: 'card stack' }, h('h3', {}, '같은 TC의 다른 플랫폼 결과'),
      h('div', { class: 'stack' }, others.map((o) => h('a', { class: 'row between', href: `#result/${run.id}/${encodeURIComponent(o.key)}`, style: 'text-decoration:none;color:inherit' }, h('span', { class: 'row' }, plat(o.platform), h('span', { class: 'sub' }, o.device)), pill(o.status))))));
  }
  app().replaceChildren(head, h('div', { class: 'result-grid' }, left, right));
}

// 요소 수리 제안: 사람이 확인하고 반영한다. 자동으로 고치지 않는 이유를 함께 보여준다
function healCard(run, r, refresh) {
  return h('section', { class: 'card stack' },
    h('h3', {}, '요소 수리 제안'),
    h('div', { class: 'sub' }, '실패 시점 화면에서 요소 맵 식별자와 비슷한 요소를 찾았습니다. 화면이 바뀐 것인지(스크립트 수정) 기능이 망가진 것인지(제품 결함) 확인한 뒤 반영하세요. 기대한 요소를 다른 요소로 바꿔 통과시키면 결함을 숨길 수 있어 자동으로 고치지 않습니다.'),
    r.heal.map((s, i) => h('div', { class: 'notice stack' },
      h('div', { class: 'row between' }, h('b', {}, `${s.label} · ${s.element}`), s.suggestion ? h('span', { class: 'sub' }, `유사도 ${Math.round(s.score * 100)}%`) : null),
      h('div', { class: 'mono' }, `현재: ${JSON.stringify(s.current)}`),
      s.suggestion ? h('div', { class: 'mono' }, `제안: ${JSON.stringify(s.suggestion)}`) : null,
      h('div', { class: 'sub' }, s.reason),
      s.suggestion ? (s.appliedAt
        ? h('div', { class: 'row' }, h('span', { class: 'ok' }, `✓ ${fmtTime(s.appliedAt)} 요소 맵에 반영함`), h('button', { class: 'btn small', type: 'button', onclick: () => startRun({ tcIds: [r.tcId], platforms: [r.platform], label: `수리 확인 ${r.tcId}` }) }, '다시 실행해 확인'))
        : h('div', { class: 'row' }, h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
          const updated = await guard(() => api('POST', `/api/runs/${run.id}/results/${encodeURIComponent(r.key)}/heal/${i}`));
          if (!updated) return;
          S.runCache[run.id] = updated;
          S.elements = await api('GET', '/api/elements');
          toast('요소 맵에 반영했습니다. 다시 실행해 확인하세요');
          refresh();
        } }, '요소 맵에 반영'), h('span', { class: 'sub' }, '반영하면 실패 분류를 "스크립트 수정 필요"로 확정하는 것이 맞습니다'))) : null)));
}

function a11yCard(file) {
  const body = h('div', { class: 'stack' }, h('span', { class: 'sub' }, '불러오는 중…'));
  fetch(file.url).then((x) => x.json()).then((d) => {
    body.replaceChildren(
      h('div', { class: 'sub' }, `WCAG 2.2 AA 자동 검사 · 위반 ${d.total}종 · 실패 기준 ${d.level} 이상`),
      d.violations.length ? h('ul', { class: 'checks a11y' }, d.violations.map((v) => h('li', {}, h('span', { class: ['critical', 'serious'].includes(v.impact) ? 'bad' : 'warn' }, v.impact), h('span', { class: 'lbl' }, v.id),
        h('span', {}, `${v.help} · ${v.count}곳 `, h('a', { href: v.helpUrl, target: '_blank', rel: 'noopener' }, '설명'))))) : h('div', { class: 'ok' }, '✓ 자동 검사로 찾은 위반이 없습니다'),
      h('div', { class: 'sub' }, '자동 검사는 WCAG 위반의 일부만 찾습니다. 키보드 이동, 스크린 리더 읽기, 대체 텍스트의 적절성은 사람이 확인해야 합니다'),
      h('a', { class: 'btn small', href: file.url, target: '_blank', rel: 'noopener' }, '전체 결과 (JSON)'));
  }).catch(() => body.replaceChildren(h('a', { href: file.url, target: '_blank', rel: 'noopener' }, '접근성 결과 열기')));
  return h('section', { class: 'card stack' }, h('h3', {}, '접근성'), body);
}

function apiCard(files) {
  const pre = h('pre', { style: 'max-height:280px' }, '');
  const show = (a) => fetch(a.url).then((x) => x.text()).then((t) => { pre.textContent = t; }).catch(() => { pre.textContent = '불러오지 못했습니다'; });
  show(files[files.length - 1]);
  return h('section', { class: 'card stack' }, h('h3', {}, 'API 응답'),
    h('div', { class: 'chips' }, files.map((a) => h('button', { class: 'chip', type: 'button', onclick: () => show(a) }, `${a.name.replace('api-', '')}번 스텝`))), pre);
}

// ---------- TC 편집 ----------
function blankTc() {
  return { id: '', title: '', priority: 'P2', automation: '적합', tags: [], reqIds: [], platforms: ['pc', 'mw'], precondition: '', steps: [{ action: 'open', target: Object.keys(S.elements.screens)[0] || '' }] };
}

async function renderTcs(id) {
  if (id && id !== S.draftId) {
    if (id === 'new') { S.draft = blankTc(); S.draftId = 'new'; }
    else {
      const tc = S.tcs.find((t) => t.id === id);
      if (!tc) { toast(`TC를 찾을 수 없습니다: ${id}`, true); location.hash = '#tcs'; return; }
      S.draft = JSON.parse(JSON.stringify(tc));
      S.draftId = id;
    }
    S.dirty = false;
    S.preview = null;
  }
  if (!id && S.tcs.length) { location.hash = `#tcs/${encodeURIComponent(S.draftId && S.draftId !== 'new' ? S.draftId : S.tcs[0].id)}`; return; }
  const search = h('input', { type: 'text', placeholder: 'ID, 제목, 태그로 찾기', id: 'tcSearch', 'aria-label': 'TC 검색' });
  const list = h('ul', { class: 'tc-list' });
  const fill = () => {
    const qv = search.value.trim().toLowerCase();
    list.replaceChildren(...S.tcs.filter((t) => !qv || `${t.id} ${t.title} ${(t.tags || []).join(' ')}`.toLowerCase().includes(qv)).map((t) => h('li', {},
      h('a', { href: `#tcs/${encodeURIComponent(t.id)}`, 'aria-current': String(t.id === S.draftId) },
        h('span', { class: 'row between' }, h('span', { class: 'id' }, `${t.id} · ${t.priority}`), h('span', { class: 'dots' }, S.meta.platforms.map((p) => h('i', { class: `${p}${t.platforms.includes(p) ? ' on' : ''}` })))),
        h('span', {}, t.title),
        t.automation === '수동 유지' ? h('span', { class: 'sub' }, '수동 유지') : null))));
  };
  search.addEventListener('input', fill);
  fill();
  const side = h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, `TC ${S.tcs.length}건`),
    h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#import' }, 'TC 가져오기'), h('a', { class: 'btn small', href: '#tcs/new' }, '새 TC'))), search, list);
  app().replaceChildren(h('div', { class: 'split' }, side, S.draft ? tcEditor() : h('div', { class: 'empty' }, 'TC가 없습니다. 새 TC를 만들어 보세요.')));
}

const poolOf = (target) => ({ screen: S.elements.screens, element: S.elements.elements, flow: S.flows, schema: S.schemas }[target] || null);

// 데이터 행 ↔ 표 텍스트. 첫 줄은 머리글(첫 칸은 행 이름), 엑셀에서 복사한 탭 구분도 그대로 붙여넣을 수 있다
function rowsToText(sets) {
  if (!sets || !sets.length) return '';
  const keys = [...new Set(sets.flatMap((r) => Object.keys(r.values)))];
  const sep = (v) => String(v).replace(/[\t\n]/g, ' ');
  return [['name', ...keys].join('\t'), ...sets.map((r) => [sep(r.name), ...keys.map((k) => sep(r.values[k] ?? ''))].join('\t'))].join('\n');
}

function textToRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.split(','));
  const [head, ...rest] = lines.map(split);
  return rest.map((cells) => ({ name: (cells[0] || '').trim(), values: Object.fromEntries(head.slice(1).map((k, i) => [k.trim(), cells[i + 1] === undefined ? '' : cells[i + 1]])) }));
}

function tcEditor() {
  const d = S.draft;
  const isNew = S.draftId === 'new';
  const mark = () => { S.dirty = true; dirtyEl.hidden = false; };
  const dirtyEl = h('span', { class: 'sub warn', hidden: !S.dirty }, '저장하지 않은 변경 있음');
  const field = (label, input, cls) => h('label', { class: `field${cls ? ` ${cls}` : ''}` }, label, input);
  const text = (key, opts = {}) => h('input', { type: 'text', value: d[key], id: `f-${key}`, ...opts, oninput: (e) => { d[key] = e.target.value; mark(); } });
  const list = (key) => h('input', { type: 'text', id: `f-${key}`, value: (d[key] || []).join(', '), oninput: (e) => { d[key] = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); mark(); } });
  const select = (key, options) => h('select', { id: `f-${key}`, onchange: (e) => { d[key] = e.target.value; mark(); } }, options.map((o) => h('option', { value: o, selected: d[key] === o }, o)));

  const form = h('div', { class: 'form-grid' },
    field('TC ID', text('id', { placeholder: 'TC-LOGIN-005' })),
    field('제목', text('title', { placeholder: '무엇을 확인하는지 한 줄로' })),
    field('우선순위', select('priority', S.meta.priorities)),
    field('자동화', select('automation', S.meta.automation)),
    field('태그 (쉼표로 구분)', list('tags')),
    field('요구사항 ID (쉼표로 구분)', list('reqIds')),
    field('수동 실행 시간 (분)', h('input', { type: 'number', min: '0', step: '0.5', id: 'f-manualMinutes', value: d.manualMinutes ?? '', placeholder: `비우면 ${(S.config.roi && S.config.roi.manualMinutesDefault) || 5}분으로 계산`, oninput: (e) => { d.manualMinutes = e.target.value === '' ? undefined : Number(e.target.value); mark(); } })),
    field('사전조건', h('textarea', { id: 'f-pre', rows: '2', oninput: (e) => { d.precondition = e.target.value; mark(); } }, d.precondition), 'wide'),
    h('div', { class: 'wide row' }, h('span', { class: 'sub' }, '플랫폼'), S.meta.platforms.map((p) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: d.platforms.includes(p), onchange: (e) => { d.platforms = e.target.checked ? [...new Set([...d.platforms, p])] : d.platforms.filter((x) => x !== p); mark(); } }), plat(p)))));

  const stepsBody = h('tbody');
  const drawSteps = () => {
    stepsBody.replaceChildren(...d.steps.map((s, i) => {
      const def = S.meta.actions[s.action];
      const targets = poolOf(def.target);
      const targetCell = def.target === 'path'
        ? h('input', { type: 'text', 'aria-label': `${i + 1}번 스텝 응답 경로`, value: s.target || '', placeholder: '응답 경로 (예: data.items[0].id)', oninput: (e) => { s.target = e.target.value; mark(); } })
        : targets ? h('select', { 'aria-label': `${i + 1}번 스텝 대상`, onchange: (e) => { s.target = e.target.value; mark(); } },
          def.targetOptional ? h('option', { value: '', selected: !s.target }, '(화면 전체)') : null,
          Object.entries(targets).map(([k, t]) => h('option', { value: k, selected: k === s.target }, t.label ? `${t.label} · ${k}` : k)))
          : h('span', { class: 'sub' }, '-');
      const valueInput = !def.value ? h('span', { class: 'sub' }, '-')
        : def.options ? h('select', { 'aria-label': `${i + 1}번 스텝 값`, onchange: (e) => { s.value = e.target.value; mark(); } },
          def.options.map((o) => h('option', { value: o, selected: (s.value || def.options[1]) === o }, o)))
          : h('input', { type: 'text', 'aria-label': `${i + 1}번 스텝 값`, value: s.value || '', placeholder: def.placeholder || '값 또는 {{account.id}}', oninput: (e) => { s.value = e.target.value; mark(); } });
      const valueCell = h('div', { class: 'stack', style: 'gap:4px' }, valueInput,
        def.body ? h('textarea', { class: 'mono', rows: '2', 'aria-label': `${i + 1}번 스텝 요청 본문`, placeholder: '요청 본문 JSON (선택) 예: {"title": "{{row.title}}"}', oninput: (e) => { s.body = e.target.value; mark(); } }, s.body || '') : null);
      const support = S.meta.platforms.map((p) => {
        const m = def.support[p];
        return h('i', { class: `${p}${m === 'run' ? ' on' : ''}`, title: `${PL(p)}: ${m === 'run' ? '실행' : m === 'noop' ? '건너뜀' : '지원 안 함'}` });
      });
      return h('tr', {},
        h('td', { class: 'num' }, i + 1),
        h('td', {}, h('select', { 'aria-label': `${i + 1}번 스텝 액션`, onchange: (e) => {
          s.action = e.target.value;
          const nd = S.meta.actions[s.action];
          const pool = poolOf(nd.target);
          if (nd.target === 'path') s.target = s.target && !pool ? s.target : '';
          else if (!pool) delete s.target;
          else if (nd.targetOptional && !pool[s.target]) s.target = '';
          else if (!pool[s.target]) s.target = Object.keys(pool)[0];
          if (!nd.value) delete s.value; else if (nd.options) s.value = nd.options[1]; else if (s.value === undefined) s.value = '';
          if (!nd.body) delete s.body;
          mark(); drawSteps();
        } }, Object.entries(S.meta.actions).map(([k, a]) => h('option', { value: k, selected: k === s.action }, `${a.label} (${k})`)))),
        h('td', {}, targetCell),
        h('td', {}, valueCell),
        h('td', {}, h('span', { class: 'dots' }, support)),
        h('td', { style: 'white-space:nowrap' },
          h('button', { class: 'icon-btn', type: 'button', title: '위로', 'aria-label': '위로', disabled: i === 0, onclick: () => { [d.steps[i - 1], d.steps[i]] = [d.steps[i], d.steps[i - 1]]; mark(); drawSteps(); } }, '↑'),
          h('button', { class: 'icon-btn', type: 'button', title: '아래로', 'aria-label': '아래로', disabled: i === d.steps.length - 1, onclick: () => { [d.steps[i + 1], d.steps[i]] = [d.steps[i], d.steps[i + 1]]; mark(); drawSteps(); } }, '↓'),
          h('button', { class: 'icon-btn', type: 'button', title: '삭제', 'aria-label': '삭제', onclick: () => { d.steps.splice(i, 1); mark(); drawSteps(); } }, '✕')));
    }));
  };
  drawSteps();

  const save = async () => {
    const saved = await guard(() => (isNew ? api('POST', '/api/tcs', d) : api('PUT', `/api/tcs/${encodeURIComponent(S.draftId)}`, d)));
    if (!saved) return;
    S.tcs = await api('GET', '/api/tcs');
    S.dirty = false;
    S.draftId = saved.id;
    S.draft = JSON.parse(JSON.stringify(saved));
    toast('저장했습니다');
    location.hash = `#tcs/${encodeURIComponent(saved.id)}`;
    renderTcs(saved.id);
  };

  const previewBox = h('div');
  const drawPreview = () => {
    if (!S.preview) { previewBox.replaceChildren(h('div', { class: 'sub' }, '코드 보기를 누르면 엔진별 변환 결과가 나옵니다')); return; }
    const p = S.preview[S.previewTab];
    previewBox.replaceChildren(
      h('div', { class: 'subtabs', role: 'tablist' }, S.meta.platforms.map((k) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === S.previewTab), onclick: () => { S.previewTab = k; drawPreview(); } }, PL(k)))),
      p.error ? h('div', { class: 'errbox' }, p.error) : h('pre', {}, p.code),
      h('div', { class: 'sub', style: 'margin-top:6px' }, { pc: 'Playwright로 실행됩니다', mw: 'Playwright 기기 에뮬레이션으로 실행됩니다', android: 'Maestro로 실행됩니다. 식별자 미부여 요소가 있으면 실행 시 Blocked 처리됩니다', ios: 'Maestro YAML 미리보기입니다. 아이폰 실행 어댑터는 다음 단계에서 붙습니다' }[S.previewTab]));
  };
  drawPreview();
  const loadPreview = async () => {
    const out = await guard(() => api('POST', '/api/preview', d));
    if (out) { S.preview = out; drawPreview(); }
  };

  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, isNew ? '새 TC' : d.id), h('div', { class: 'row' }, dirtyEl,
      !isNew ? h('button', { class: 'btn', type: 'button', onclick: () => { if (S.dirty) { toast('저장한 뒤 실행하세요', true); return; } startRun({ tcIds: [d.id], platforms: d.platforms, label: `단건 실행 ${d.id}` }); } }, '이 TC만 실행') : null,
      !isNew ? h('button', { class: 'btn', type: 'button', onclick: () => { S.draft = { ...JSON.parse(JSON.stringify(d)), id: `${d.id}-COPY` }; S.draftId = 'new'; S.dirty = true; location.hash = '#tcs/new'; renderTcs('new'); } }, '복제') : null,
      !isNew ? confirmButton('삭제', async () => { if (await guard(() => api('DELETE', `/api/tcs/${encodeURIComponent(d.id)}`))) { S.tcs = await api('GET', '/api/tcs'); S.draftId = null; S.draft = null; S.dirty = false; toast('삭제했습니다'); location.hash = '#tcs'; renderTcs(); } }) : null,
      h('button', { class: 'btn primary', type: 'button', onclick: save }, '저장'))),
    form,
    d.source ? h('details', { class: 'notice', open: d.automation === '수동 유지' },
      h('summary', {}, `${d.source.url ? '스프레드시트' : '엑셀'} 원문 · ${d.source.file} ${d.source.sheet} ${d.source.row}행${d.source.originalId ? ` · 원래 ID ${d.source.originalId}` : ''}`),
      d.source.url ? h('div', { style: 'margin-top:6px' }, h('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, '원본 시트 열기')) : null,
      h('div', { class: 'grid2', style: 'margin-top:8px' },
        h('div', {}, h('div', { class: 'sub' }, '테스트 절차'), h('pre', { style: 'white-space:pre-wrap' }, d.source.steps || '-')),
        h('div', {}, h('div', { class: 'sub' }, '기대결과'), h('pre', { style: 'white-space:pre-wrap' }, d.source.expected || '-'))),
      h('div', { class: 'sub', style: 'margin-top:6px' }, '원문을 보고 아래 스텝을 채운 뒤 자동화를 "적합"으로 바꾸면 실행 대상이 됩니다')) : null,
    h('div', { class: 'row between' }, h('h3', {}, `스텝 ${d.steps.length}개`), h('span', { class: 'sub' }, '점은 플랫폼 지원 여부 (PC · MW · 안드로이드 · 아이폰 · API)')),
    h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', '액션', '대상', '값', '지원', ''].map((t) => h('th', {}, t)))), stepsBody)),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { d.steps.push({ action: 'tap', target: Object.keys(S.elements.elements)[0] }); mark(); drawSteps(); } }, '스텝 추가'),
      h('span', { class: 'sub' }, '값에 {{account.id}}처럼 쓰면 data/testdata.json 값으로 바뀌고, 리포트에는 실제 값 대신 이름만 남습니다. {{row.키}}는 아래 데이터 행 값, {{saved.이름}}은 앞의 "응답 값 저장" 스텝 값입니다')),
    h('details', { class: 'notice', open: !!(d.dataSets && d.dataSets.length) },
      h('summary', {}, `데이터 행 (데이터 주도) · ${(d.dataSets || []).length}행`),
      h('div', { class: 'stack', style: 'margin-top:8px' },
        h('div', { class: 'sub' }, '같은 스텝을 행마다 한 번씩 실행합니다. 첫 줄은 머리글이고 첫 칸은 행 이름입니다. 엑셀에서 표를 복사해 붙여넣어도 됩니다. 실제 비밀번호는 넣지 말고 테스트 데이터의 비밀값을 쓰세요.'),
        h('textarea', { class: 'mono', rows: '5', id: 'f-rows', placeholder: 'name\tid\terror\n아이디 비움\t\tEpic sadface: Username is required', oninput: (e) => { d.dataSets = textToRows(e.target.value); mark(); } }, rowsToText(d.dataSets)))),
    h('div', { class: 'row between' }, h('h3', {}, '엔진별 코드'), h('button', { class: 'btn small', type: 'button', onclick: loadPreview }, '코드 보기')),
    previewBox);
}

// ---------- 엑셀 가져오기 ----------
const IMPORT_FIELDS = { id: 'TC ID', title: '제목', precondition: '사전조건', steps: '테스트 절차', expected: '기대결과', priority: '우선순위', platform: '플랫폼', reqIds: '요구사항 ID' };
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function stepText(s) {
  if (!s) return '';
  const def = S.meta.actions[s.action];
  const t = s.target ? (S.elements.elements[s.target] || S.elements.screens[s.target] || {}).label || s.target : '';
  return `${def ? def.label : s.action}${t ? ` · ${t}` : ''}${s.value !== undefined ? ` = "${s.value}"` : ''}`;
}

async function previewImport(extra = {}) {
  const imp = S.imp;
  imp.loading = true;
  renderImport();
  const src = imp.url ? { url: imp.url } : { fileName: imp.fileName, data: imp.data };
  const p = await guard(() => api('POST', '/api/import/preview', { ...src, sheet: imp.sheet, mapping: imp.mapping, ...extra }));
  imp.loading = false;
  if (!p && !imp.preview) imp.fileName = null;
  if (p) {
    imp.preview = p;
    imp.fileName = p.fileName;
    imp.sheet = p.sheet;
    imp.selected = new Set(p.tcs.filter((t) => !t.exists).map((t) => t.tc.id));
    imp.open = new Set();
    imp.result = null;
  }
  renderImport();
}

function renderImport() {
  S.imp = S.imp || {};
  const imp = S.imp;
  const fileInput = h('input', { type: 'file', id: 'importFile', accept: '.xlsx,.csv,.tsv', hidden: true, onchange: (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 14 * 1024 * 1024) { toast('파일이 너무 큽니다 (최대 14MB)', true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      S.imp = { fileName: f.name, data: String(reader.result).split(',')[1], sheet: undefined, mapping: undefined };
      previewImport();
    };
    reader.onerror = () => toast('파일을 읽지 못했습니다', true);
    reader.readAsDataURL(f);
  } });

  const intro = h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('div', {}, h('h2', {}, 'TC 가져오기 · 엑셀 · 스프레드시트'),
      h('div', { class: 'sub' }, '머리글(TC ID, 테스트 항목, 테스트 절차, 기대결과, 우선순위, 플랫폼 등)로 열을 찾고, 절차·기대결과 문장을 요소 맵 이름으로 자동화 스텝으로 바꿉니다. 바꾸지 못한 문장이 있는 TC는 "수동 유지"로 원문과 함께 가져옵니다.')),
      h('a', { class: 'btn', href: '/api/import/template', download: 'AutoTC_TC양식.xlsx' }, '양식 받기')),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' }, h('div', { class: 'sub' }, '파일 올리기 · 엑셀(.xlsx), CSV/TSV'),
        h('div', { class: 'row' }, h('label', { class: 'btn primary', for: 'importFile', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } }, '파일 선택'), fileInput)),
      h('form', { class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        const url = e.target.querySelector('input').value.trim();
        if (!url) { toast('Google 스프레드시트 링크를 붙여넣으세요', true); return; }
        S.imp = { url, fileName: 'Google 스프레드시트', sheet: undefined, mapping: undefined };
        previewImport();
      } },
        h('label', { class: 'sub', for: 'sheetUrl' }, 'Google 스프레드시트 링크 · 공유: 링크가 있는 모든 사용자(뷰어)'),
        h('div', { class: 'row' },
          h('input', { type: 'text', id: 'sheetUrl', placeholder: 'https://docs.google.com/spreadsheets/d/...', value: imp.url || '', style: 'flex:1;min-width:0' }),
          h('button', { class: 'btn primary', type: 'submit' }, '불러오기')))),
    imp.fileName ? h('div', { class: 'row' }, h('span', { class: 'sub' }, imp.loading ? `${imp.fileName} 읽는 중…` : `불러온 자료: ${imp.fileName}`),
      imp.url && !imp.loading ? h('button', { class: 'btn small', type: 'button', onclick: () => previewImport({ refresh: true }) }, '다시 불러오기') : null) : null);

  const parts = [intro];
  const p = imp.preview;
  if (p && !imp.loading) {
    const sheetSel = p.sheets.length > 1 ? h('label', { class: 'field' }, '시트', h('select', { id: 'importSheet', onchange: (e) => { imp.sheet = e.target.value; imp.mapping = undefined; previewImport(); } }, p.sheets.map((s) => h('option', { value: s, selected: s === p.sheet }, s)))) : null;
    const fieldSel = (f) => h('label', { class: 'field' }, IMPORT_FIELDS[f], h('select', { id: `map-${f}`, onchange: (e) => {
      const m = { ...p.mapping };
      if (e.target.value === '') delete m[f]; else m[f] = Number(e.target.value);
      imp.mapping = m;
      previewImport();
    } }, h('option', { value: '' }, '(없음)'), p.headers.map((hd, i) => (hd ? h('option', { value: String(i), selected: p.mapping[f] === i }, `${colName(i)}열 · ${hd}`) : null))));
    parts.push(h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', {}, '열 배치'), h('span', { class: 'sub' }, `${p.sheet} 시트 · 머리글 ${p.headerRow || '-'}행${p.mapping.category && p.mapping.category.length ? ` · 분류(태그): ${p.mapping.category.map((i) => p.headers[i]).join(', ')}` : ''}`)),
      h('div', { class: 'map-grid' }, sheetSel, Object.keys(IMPORT_FIELDS).map(fieldSel)),
      p.warnings.length ? h('div', { class: 'errbox' }, p.warnings.join('\n')) : null));

    if (p.tcs.length) {
      const ok = p.tcs.filter((t) => t.tc.automation === '적합').length;
      const existing = p.tcs.filter((t) => t.exists).length;
      const allChecked = p.tcs.every((t) => imp.selected.has(t.tc.id));
      const rows = [];
      p.tcs.forEach((t) => {
        const conv = t.lines.filter((l) => l.ok).length;
        const opened = imp.open.has(t.tc.id);
        rows.push(h('tr', {},
          h('td', {}, h('input', { type: 'checkbox', 'aria-label': `${t.tc.id} 선택`, checked: imp.selected.has(t.tc.id), onchange: (e) => { if (e.target.checked) imp.selected.add(t.tc.id); else imp.selected.delete(t.tc.id); renderImport(); } })),
          h('td', { class: 'mono' }, t.tc.id, t.exists ? h('div', { class: 'sub warn' }, '이미 있는 ID') : null),
          h('td', {}, t.tc.title, t.tc.tags.length ? h('div', { class: 'sub' }, t.tc.tags.join(' · ')) : null),
          h('td', {}, t.tc.priority),
          h('td', {}, h('span', { class: 'dots' }, S.meta.platforms.map((pl) => h('i', { class: `${pl}${t.tc.platforms.includes(pl) ? ' on' : ''}`, title: PL(pl) })))),
          h('td', { class: 'num' }, `${conv}/${t.lines.length}`),
          h('td', {}, h('span', { class: `pill ${t.tc.automation === '적합' ? 's-Pass' : 's-Blocked'}` }, t.tc.automation === '적합' ? '자동화 가능' : '수동 유지')),
          h('td', {}, h('button', { class: 'btn small', type: 'button', 'aria-expanded': String(opened), onclick: () => { if (opened) imp.open.delete(t.tc.id); else imp.open.add(t.tc.id); renderImport(); } }, opened ? '접기' : '변환 보기'))));
        if (opened) {
          rows.push(h('tr', {}, h('td', { colspan: '8', style: 'background:var(--sunken)' },
            h('div', { class: 'stack' },
              [...t.notes, ...t.problems].length ? h('div', { class: 'sub warn' }, [...t.notes, ...t.problems].join(' · ')) : null,
              h('ol', { class: 'steps' }, t.lines.map((l) => h('li', { class: l.ok ? '' : 'failed' },
                h('span', { class: `mark ${l.ok ? 'ok' : 'bad'}` }, l.ok ? '✓' : '✕'),
                h('span', {}, h('span', { class: 'sub' }, l.kind === 'step' ? '절차 ' : '기대 '), l.text, h('div', { class: l.ok ? 'sub' : 'sub bad' }, l.ok ? `→ ${stepText(l.step)}` : l.reason)),
                h('span', {}))))))));
        }
      });
      const doImport = async () => {
        const tcs = p.tcs.filter((t) => imp.selected.has(t.tc.id)).map((t) => t.tc);
        const r = await guard(() => api('POST', '/api/import/commit', { tcs, overwrite: !!imp.overwrite }));
        if (!r) return;
        imp.result = r;
        S.tcs = await api('GET', '/api/tcs');
        toast(`추가 ${r.added.length} · 덮어쓰기 ${r.updated.length} · 건너뜀 ${r.skipped.length} · 실패 ${r.failed.length}`, r.failed.length > 0);
        const ids = new Set(S.tcs.map((x) => x.id));
        p.tcs.forEach((t) => { t.exists = ids.has(t.tc.id); });
        imp.selected = new Set();
        renderImport();
      };
      parts.push(h('section', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('div', {}, h('h3', {}, `TC ${p.tcs.length}건`), h('div', { class: 'sub' }, `자동화 가능 ${ok}건 · 수동 유지 ${p.tcs.length - ok}건 · 이미 있는 ID ${existing}건`)),
          h('div', { class: 'row' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'importOverwrite', checked: !!imp.overwrite, onchange: (e) => { imp.overwrite = e.target.checked; } }), '같은 ID는 덮어쓰기'),
            h('button', { class: 'btn primary', type: 'button', disabled: imp.selected.size === 0, onclick: doImport }, `선택한 ${imp.selected.size}건 가져오기`))),
        imp.result ? h('div', { class: 'notice' },
          `추가 ${imp.result.added.length}건, 덮어쓰기 ${imp.result.updated.length}건, 건너뜀 ${imp.result.skipped.length}건, 실패 ${imp.result.failed.length}건. `,
          h('a', { href: `#tcs/${encodeURIComponent((imp.result.added[0] || imp.result.updated[0] || ''))}` }, 'TC 편집에서 보기'),
          [...imp.result.skipped, ...imp.result.failed].map((x) => h('div', { class: 'sub' }, `${x.id}: ${x.reason}`))) : null,
        h('div', { class: 'tbl' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, h('input', { type: 'checkbox', 'aria-label': '전체 선택', checked: allChecked, onchange: (e) => { imp.selected = new Set(e.target.checked ? p.tcs.map((t) => t.tc.id) : []); renderImport(); } })),
            ['ID', '제목', '우선순위', '플랫폼', '변환', '결과', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, rows)))));
    } else {
      parts.push(h('div', { class: 'empty' }, '가져올 TC를 찾지 못했습니다. 열 배치를 확인하세요.'));
    }
  }
  app().replaceChildren(...parts);
}

// ---------- 영역 매핑 ----------
const CONF = { high: ['s-Pass', '높음'], mid: ['s-Flaky', '중간'], low: ['s-Fail', '낮음'], none: ['s-none', '근거 없음'] };
const REVIEW_LABEL = { pending: '검토 대기', approved: '승인', edited: '수정 후 승인', inquiry: '기획 문의', rejected: '제외' };
const confPill = (lv) => h('span', { class: `pill ${CONF[lv][0]}` }, CONF[lv][1]);

function readFileB64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error(`${f.name}을(를) 읽지 못했습니다`));
    r.readAsDataURL(f);
  });
}

function aiSettingsCard(st, onSaved) {
  const keyIn = h('input', { type: 'text', id: 'aiKey', placeholder: st.apiKey ? `저장됨 ${st.apiKey}` : 'sk-ant-...', autocomplete: 'off', style: 'width:100%' });
  const figIn = h('input', { type: 'text', id: 'figmaToken', placeholder: st.figmaToken ? `저장됨 ${st.figmaToken}` : 'figd_... (선택)', autocomplete: 'off', style: 'width:100%' });
  const consent = h('input', { type: 'checkbox', id: 'aiConsent', checked: st.consent });
  const save = async () => {
    const body = { consent: consent.checked };
    if (keyIn.value.trim()) body.apiKey = keyIn.value.trim();
    if (figIn.value.trim()) body.figmaToken = figIn.value.trim();
    const r = await guard(() => api('PUT', '/api/ai/settings', body));
    if (r) { toast('설정을 저장했습니다'); onSaved(r); }
  };
  return h('section', { class: 'card stack' },
    h('h3', {}, '설정'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, `Claude API 키${st.apiKeySource === 'env' ? ' (환경변수 ANTHROPIC_API_KEY 사용 중)' : ''}`, keyIn),
      h('label', { class: 'field' }, `피그마 개인 액세스 토큰${st.figmaTokenSource === 'env' ? ' (환경변수 FIGMA_TOKEN 사용 중)' : ''}`, figIn)),
    h('label', { class: 'check' }, consent, '기획서·디자인 이미지·TC를 Claude API(Anthropic)로 보내는 것에 동의합니다'),
    h('div', { class: 'sub' }, '고객사 자료는 외부 AI 전송이 허용되는지 먼저 확인하세요. 키와 토큰은 이 PC의 data/state/ai.json에만 저장되고 Git에는 올라가지 않습니다.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: save }, '설정 저장'),
      st.apiKeySource === 'saved' ? confirmButton('API 키 삭제', async () => {
        const r = await guard(() => api('PUT', '/api/ai/settings', { apiKey: '' }));
        if (r) { toast('API 키를 삭제했습니다'); onSaved(r); }
      }, 'btn') : null,
      st.figmaTokenSource === 'saved' ? confirmButton('피그마 토큰 삭제', async () => {
        const r = await guard(() => api('PUT', '/api/ai/settings', { figmaToken: '' }));
        if (r) { toast('피그마 토큰을 삭제했습니다'); onSaved(r); }
      }, 'btn') : null,
      h('button', { class: 'btn', type: 'button', disabled: !st.apiKey, onclick: async () => {
        const r = await guard(() => api('POST', '/api/ai/check'));
        if (r) toast(r.message, !r.ok);
      } }, '키 확인 (무료)'),
      h('span', { class: 'sub' }, '키 확인은 모델 정보 조회라 비용이 들지 않습니다')));
}

async function renderMapping(pid) {
  if (!pid) return renderMappingList();
  const v = await guard(() => api('GET', `/api/mapping/${pid}`));
  if (!v) { location.hash = '#mapping'; return; }
  S.map = S.map && S.map.id === pid ? Object.assign(S.map, { v }) : { id: pid, v, sel: null, showGaps: false };
  S.map.ai = await api('GET', '/api/ai/settings').catch(() => null);
  if (v.status === 'running' && !S.mapPoll) {
    S.mapPoll = setInterval(async () => {
      const nv = await api('GET', `/api/mapping/${pid}`).catch(() => null);
      if (!nv) return;
      S.map.v = nv;
      if (nv.status !== 'running') {
        clearInterval(S.mapPoll); S.mapPoll = null;
        toast(nv.status === 'done' ? '분석을 마쳤습니다' : `분석 오류: ${nv.error}`, nv.status !== 'done');
      }
      if (location.hash.startsWith(`#mapping/${pid}`)) drawMapping();
    }, 2000);
  }
  drawMapping();
}

async function renderMappingList() {
  const [list, st] = await Promise.all([api('GET', '/api/mapping'), api('GET', '/api/ai/settings')]);
  const nameIn = h('input', { type: 'text', id: 'mapName', placeholder: '예: 로그인·회원가입 v1.3', style: 'flex:1;min-width:0' });
  app().replaceChildren(
    h('section', { class: 'card stack' },
      h('div', {}, h('h2', {}, 'TC 영역 매핑'), h('div', { class: 'sub' }, '기획서와 화면 디자인을 Claude가 읽고, TC가 어느 화면의 어느 영역을 다루는지 근거와 함께 찾습니다. 확신도는 규칙으로 계산하고, QA가 승인한 결과만 요소 맵과 TC에 반영합니다.')),
      h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const p = await guard(() => api('POST', '/api/mapping', { name: nameIn.value })); if (p) location.hash = `#mapping/${p.id}`; } },
        nameIn, h('button', { class: 'btn primary', type: 'submit' }, '새 매핑 만들기')),
      list.length ? h('div', { class: 'tbl' }, h('table', {},
        h('thead', {}, h('tr', {}, ['이름', '기획서', '화면', 'TC', '분석', '상태'].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((p) => h('tr', { class: 'clickable', tabindex: '0', onclick: () => { location.hash = `#mapping/${p.id}`; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#mapping/${p.id}`; } },
          h('td', {}, p.name), h('td', { class: 'num' }, p.specs), h('td', { class: 'num' }, p.frames), h('td', { class: 'num' }, p.tcs), h('td', { class: 'num' }, p.results),
          h('td', {}, { idle: '준비', running: '분석 중', done: '완료', error: '오류' }[p.status] || p.status))))))
        : h('div', { class: 'empty' }, '아직 매핑이 없습니다. 이름을 넣고 새 매핑을 만드세요.')),
    aiSettingsCard(st, () => renderMappingList()));
}

function drawMapping() {
  const { v } = S.map;
  const pid = v.id;
  const busy = v.status === 'running';
  const refresh = (nv) => { if (nv) { S.map.v = nv; drawMapping(); } };

  // 자료
  const specInput = h('input', { type: 'file', id: 'specFiles', multiple: true, hidden: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.txt,.md' });
  const frameInput = h('input', { type: 'file', id: 'frameFiles', multiple: true, hidden: true, accept: '.png,.jpg,.jpeg,.webp' });
  const upload = (kind) => async (e) => {
    const files = [...e.target.files];
    let last = null;
    for (const f of files) {
      toast(`${f.name} 올리는 중…`);
      const data = await readFileB64(f).catch((err) => { toast(err.message, true); return null; });
      if (!data) continue;
      last = await guard(() => api('POST', `/api/mapping/${pid}/files`, { kind, fileName: f.name, data })) || last;
    }
    refresh(last);
  };
  specInput.addEventListener('change', upload('spec'));
  frameInput.addEventListener('change', upload('frame'));
  const figmaIn = h('input', { type: 'text', id: 'figmaUrl', placeholder: 'https://www.figma.com/design/...?node-id=...', value: v.figma ? v.figma.url : '', style: 'flex:1;min-width:0' });
  const del = (fid) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': '삭제', title: '삭제', disabled: busy, onclick: async () => refresh(await guard(() => api('DELETE', `/api/mapping/${pid}/files/${fid}`))) }, '✕');

  const materials = h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('div', {}, h('a', { href: '#mapping' }, '← 매핑 목록'), h('h2', {}, v.name)),
      h('span', { class: 'sub' }, `누적 사용 ${v.usage ? `${v.usage.calls}회 · 약 $${v.usd}` : '없음'}`)),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('h3', {}, `기획서 ${v.specs.length}개`), h('label', { class: 'btn small', for: 'specFiles' }, '기획서 올리기'), specInput),
        h('div', { class: 'sub' }, 'PDF, 이미지, 텍스트(.txt/.md). PPT·워드는 PDF로 저장해 올립니다. 텍스트 기획서는 인용문을 원문과 대조합니다.'),
        v.specs.length ? h('ul', { class: 'checks' }, v.specs.map((s) => h('li', { style: 'grid-template-columns:28px minmax(0,1fr) auto' }, h('span', { class: 'mono sub' }, s.id), h('span', {}, s.name, h('span', { class: 'sub' }, ` · ${s.kind}`)), del(s.id)))) : null),
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('h3', {}, `화면 디자인 ${v.frames.length}개`), h('label', { class: 'btn small', for: 'frameFiles' }, '캡처 올리기'), frameInput),
        h('form', { class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          toast('피그마에서 프레임을 가져오는 중…');
          const r = await guard(() => api('POST', `/api/mapping/${pid}/figma`, { url: figmaIn.value }));
          if (r) { toast(`프레임 ${r.added}개를 가져왔습니다${r.skipped ? ` (${r.skipped}개는 개수 제한으로 제외)` : ''}`); refresh(r); }
        } }, figmaIn, h('button', { class: 'btn small', type: 'submit', disabled: busy }, '피그마에서 가져오기')),
        h('div', { class: 'sub' }, '캡처 파일 이름이 화면 이름이 됩니다 (예: 01_Login_error.png). 에러·팝업 같은 상태 화면도 함께 넣으세요.'),
        v.frames.length ? h('div', { class: 'thumbs' }, v.frames.map((f) => h('figure', {},
          h('img', { src: `/mapping-files/${pid}/${f.file}`, alt: f.name, loading: 'lazy' }),
          h('figcaption', { class: 'row between' }, h('span', {}, h('span', { class: 'mono sub' }, `${f.id} `), f.name, f.source === 'figma' ? h('span', { class: 'sub' }, ' · 피그마') : null), del(f.id))))) : null)));

  // TC 선택
  const chosen = new Set(v.tcIds);
  const tcBox = h('div', { class: 'tc-pick' }, S.tcs.map((t) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: t.id, checked: chosen.has(t.id), disabled: busy }),
    h('span', { class: 'mono sub' }, t.id),
    // 제목과 상태 표시를 한 칸에 둔다 (칸이 나뉘면 표시가 다음 줄 좁은 칸으로 밀린다)
    h('span', {}, t.title,
      t.automation === '수동 유지' ? h('span', { class: 'sub' }, ' · 수동 유지') : null,
      v.results[t.id] ? h('span', { class: 'sub' }, ' · 분석됨') : null))));
  const saveTcs = async () => {
    const ids = [...tcBox.querySelectorAll('input:checked')].map((i) => i.value);
    refresh(await guard(() => api('PUT', `/api/mapping/${pid}`, { tcIds: ids })));
  };
  const tcCard = h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h3', {}, `분석할 TC ${v.tcIds.length}건`),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', disabled: busy, onclick: () => { tcBox.querySelectorAll('input').forEach((i) => { i.checked = true; }); } }, '전체 선택'),
        h('button', { class: 'btn small primary', type: 'button', disabled: busy, onclick: saveTcs }, '선택 저장'))),
    tcBox);

  // 분석
  const start = async (onlyNew) => {
    const r = await guard(() => api('POST', `/api/mapping/${pid}/analyze`, { onlyNew }));
    if (r) { toast('분석을 시작했습니다'); renderMapping(pid); }
  };
  const est = v.estimate;
  const hasResults = Object.keys(v.results).length > 0;
  const figmaFrames = v.frames.filter((f) => f.texts && f.texts.length).length;
  const runRules = async (onlyNew) => {
    const nv = await guard(() => api('POST', `/api/mapping/${pid}/analyze-rules`, { onlyNew }));
    if (nv) { toast('규칙 기반 분석을 마쳤습니다'); refresh(nv); }
  };
  const runClaudeCode = async (onlyNew) => {
    const nv = await guard(() => api('POST', `/api/mapping/${pid}/claude-code/export`, { onlyNew }));
    if (nv) { toast('Claude Code 요청 파일을 만들었습니다'); refresh(nv); }
  };
  const importCc = async () => {
    const nv = await guard(() => api('POST', `/api/mapping/${pid}/claude-code/import`));
    if (nv) { toast(`Claude Code 결과 ${nv.imported}건을 가져왔습니다`); refresh(nv); }
  };
  const mode = (title, cost, desc, buttons) => h('div', { class: 'mode' }, h('div', { class: 'row between' }, h('b', {}, title), h('span', { class: 'pill s-Pass' }, cost)), h('div', { class: 'sub' }, desc), h('div', { class: 'row' }, buttons));
  const ccPrompt = v.claudeCode ? `${v.claudeCode.requestFile} 파일을 읽고, 안의 지시대로 화면·기획서를 분석해서 ${v.claudeCode.responseFile} 에 결과를 저장해 줘.` : '';
  const runCard = h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h3', {}, '분석 방법'),
      busy ? h('span', { class: 'sub' }, `${v.phase || '분석 중'} · ${v.progress ? `${v.progress.done}/${v.progress.total}` : ''}`) : null),
    busy && v.progress ? h('div', { class: 'bar' }, h('i', { class: 'Pass', style: `width:${(v.progress.done / Math.max(1, v.progress.total)) * 100}%` })) : null,
    !busy ? h('div', { class: 'modes' },
      mode('규칙 기반', '무료', `AI 없이 피그마 텍스트·버튼 레이어와 텍스트 기획서로 찾습니다. 피그마에서 가져온 화면 ${figmaFrames}개에서만 위치를 찾고, 캡처 이미지는 읽지 못합니다.`, [
        h('button', { class: 'btn primary', type: 'button', onclick: () => runRules(true) }, '새 TC 분석'),
        hasResults ? h('button', { class: 'btn', type: 'button', onclick: () => runRules(false) }, '전체 다시') : null]),
      mode('Claude Code', '구독 안에서', '요청 파일을 만들면 Claude Code 대화창에서 분석을 맡깁니다. 캡처·PDF도 읽고 정확도는 API와 같은 수준이며, API 비용이 들지 않습니다.', [
        h('button', { class: 'btn primary', type: 'button', onclick: () => runClaudeCode(true) }, '요청 파일 만들기'),
        hasResults ? h('button', { class: 'btn', type: 'button', onclick: () => runClaudeCode(false) }, '전체 TC로 만들기') : null]),
      mode('Claude API', est.calls ? `유료 · 약 $${est.usd}` : '유료', `버튼 한 번으로 자동 분석합니다. platform.claude.com 크레딧에서 사용한 만큼 결제됩니다${S.map.ai && S.map.ai.apiKey ? '' : ' (API 키 없음 · 설정에서 입력)'}.`, [
        h('button', { class: 'btn', type: 'button', disabled: !est.calls || !(S.map.ai && S.map.ai.apiKey), onclick: () => start(true) }, est.calls ? `새 TC 분석 (호출 ${est.calls}회)` : '새로 분석할 TC 없음'),
        hasResults ? h('button', { class: 'btn', type: 'button', disabled: !(S.map.ai && S.map.ai.apiKey), onclick: () => start(false) }, `전체 다시 (약 $${v.estimateAll.usd})`) : null])) : null,
    v.claudeCode && !busy ? h('div', { class: 'notice stack' },
      h('b', {}, `Claude Code 요청 · TC ${v.claudeCode.tcIds.length}건 · ${fmtTime(v.claudeCode.at)}`),
      h('div', {}, 'Claude Code 대화창에 아래 문장을 붙여넣으세요. 분석이 끝나면 "응답 가져오기"를 누릅니다.'),
      h('pre', { style: 'white-space:pre-wrap' }, ccPrompt),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => copyText(ccPrompt) }, '요청 문장 복사'),
        h('button', { class: 'btn small primary', type: 'button', onclick: importCc }, '응답 가져오기'))) : null,
    v.error ? h('div', { class: 'errbox' }, v.error) : null,
    v.lastRun && v.lastRun.errors.length && !busy ? h('div', { class: 'errbox' }, v.lastRun.errors.slice(0, 5).join('\n')) : null);

  const parts = [materials, tcCard, runCard];
  if (Object.keys(v.results).length) parts.push(reviewCard(v, refresh));
  app().replaceChildren(...parts);
}

function reviewCard(v, refresh) {
  const pid = v.id;
  const results = Object.values(v.results);
  const order = { none: 0, low: 1, mid: 2, high: 3 };
  results.sort((a, b) => order[a.confidence.level] - order[b.confidence.level] || a.tcId.localeCompare(b.tcId));
  if (!S.map.sel || !v.results[S.map.sel]) S.map.sel = results[0].tcId;
  const r = v.results[S.map.sel];
  const gaps = S.map.showGaps;
  const frameId = gaps ? (S.map.gapFrame || (v.frames[0] && v.frames[0].id)) : (r.frame || (r.steps.find((s) => s.frame) || {}).frame);
  const fr = v.frames.find((f) => f.id === frameId);

  const list = h('ul', { class: 'tc-list', style: 'max-height:640px' }, results.map((x) => h('li', {},
    h('a', { href: `#mapping/${pid}`, 'aria-current': String(!gaps && x.tcId === S.map.sel), onclick: (e) => { e.preventDefault(); S.map.sel = x.tcId; S.map.showGaps = false; drawMapping(); } },
      h('span', { class: 'id' }, x.tcId), h('span', {}, x.title),
      h('span', {}, confPill(x.confidence.level), h('span', { class: 'sub' }, ` ${REVIEW_LABEL[x.review.status]}${x.review.appliedAt ? ' · 반영됨' : ''}`))))));

  // 화면 위 영역 표시
  const boxes = gaps
    ? v.coverage.uncovered.filter((e) => e.frame === frameId).map((e) => ({ box: e.box, label: e.name, cls: 'gap' }))
    : r.steps.filter((s) => s.box && s.frame === frameId && s.box[2] * s.box[3] < 0.9).map((s) => ({ box: s.box, label: String(s.lineNo), cls: '' }));
  const frameView = fr ? h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('span', { class: 'sub' }, `${fr.id} · ${fr.name}`),
      gaps && v.frames.length > 1 ? h('select', { 'aria-label': '화면 선택', onchange: (e) => { S.map.gapFrame = e.target.value; drawMapping(); } }, v.frames.map((f) => h('option', { value: f.id, selected: f.id === frameId }, f.name))) : null),
    h('div', { class: 'frame-view' }, h('img', { src: `/mapping-files/${pid}/${fr.file}`, alt: fr.name }),
      boxes.map((b) => h('div', { class: `ov ${b.cls}`, style: `left:${b.box[0] * 100}%;top:${b.box[1] * 100}%;width:${b.box[2] * 100}%;height:${b.box[3] * 100}%`, title: b.label }, h('span', {}, b.label)))))
    : h('div', { class: 'empty' }, gaps ? '화면이 없습니다' : '이 TC의 화면을 찾지 못했습니다');

  // 상세
  const elOptions = Object.entries(S.elements.elements);
  const edits = new Map();
  const doReview = async (status) => {
    const note = status === 'inquiry' ? noteIn.value : undefined;
    const nv = await guard(() => api('PUT', `/api/mapping/${pid}/results/${encodeURIComponent(r.tcId)}`, { status, edits: [...edits.values()], note }));
    if (nv) { toast(`${r.tcId}: ${REVIEW_LABEL[nv.results[r.tcId].review.status]}`); refresh(nv); }
  };
  const noteIn = h('input', { type: 'text', id: 'mapNote', placeholder: '기획 문의 내용 (예: 잠금 팝업 디자인 요청)', value: r.review.note || '', style: 'width:100%' });
  const detail = gaps
    ? h('div', { class: 'stack' }, h('h3', {}, `TC 없는 영역 ${v.coverage.uncovered.length}곳`),
      h('div', { class: 'sub' }, '디자인에는 있지만 어떤 TC도 다루지 않는 버튼·입력창·링크·탭입니다. 다른 화면 TC에서 다루는지 확인하고, 없으면 TC 추가 대상으로 정리하세요.'),
      h('ul', { class: 'checks' }, v.coverage.uncovered.map((e) => h('li', { style: 'grid-template-columns:minmax(0,1fr) auto' }, h('span', {}, `${e.frameName} · ${e.name}`), h('span', { class: 'sub' }, e.kind)))),
      v.coverage.noEvidence.length ? h('div', { class: 'notice' }, `기획서 근거가 없는 TC: ${v.coverage.noEvidence.join(', ')}`) : null,
      v.coverage.missingStates.length ? h('div', { class: 'notice' }, '디자인에 없는 상태: ', v.coverage.missingStates.map((m) => `${m.tcId}(${m.states.join(', ')})`).join(' · ')) : null)
    : h('div', { class: 'stack' },
      h('div', {}, h('div', { class: 'mono sub' }, `${r.tcId} · ${{ rules: '규칙 기반', 'claude-code': 'Claude Code', api: 'Claude API' }[r.method] || 'Claude API'} 분석`), h('b', {}, r.title)),
      h('div', {}, confPill(r.confidence.level), ' ', h('span', { class: 'sub' }, r.confidence.reasons.join(' · '))),
      h('ol', { class: 'steps' }, r.steps.map((s) => {
        const sel = h('select', { 'aria-label': `${s.lineNo}번 요소`, onchange: (e) => {
          const val = e.target.value;
          edits.set(s.lineNo, val.startsWith('new:') ? { lineNo: s.lineNo, suggestedKey: val.slice(4) } : { lineNo: s.lineNo, elementKey: val });
        } },
        h('option', { value: '' }, '(요소 없음)'),
        s.suggestedKey ? h('option', { value: `new:${s.suggestedKey}`, selected: !s.elementKey }, `새 요소 ${s.suggestedKey}`) : null,
        elOptions.map(([k, el]) => h('option', { value: k, selected: k === s.elementKey }, `${el.label} · ${k}`)));
        return h('li', { class: !s.box ? 'failed' : '' },
          h('span', { class: 'mark mono' }, s.lineNo),
          h('span', { class: 'stack', style: 'gap:4px' },
            h('span', {}, h('span', { class: 'sub' }, s.kind === 'expected' ? '기대 ' : '절차 '), s.text),
            h('span', { class: 'sub' }, `${s.name || '대상 못 찾음'} · 후보 ${s.candidates}개${s.designTextMatch === false && /"/.test(s.text) ? ` · 문구 불일치${s.textCheck === 'figma' ? '(피그마 대조)' : ''}` : ''}${s.note ? ` · ${s.note}` : ''}`),
            sel),
          h('span', {}));
      })),
      r.evidence.length ? h('div', { class: 'stack' }, h('div', { class: 'sub' }, '기획서 근거'), r.evidence.map((e) => h('div', { class: 'notice' },
        h('b', {}, e.policyId || e.specName), e.page > 0 ? ` · ${e.page}쪽` : '', ` · ${e.verified ? '원문 확인됨' : '원문 대조 불가(PDF·이미지)'}`, h('div', {}, `"${e.quote}"`)))) : h('div', { class: 'sub warn' }, '기획서 근거 없음'),
      r.missingInDesign.length ? h('div', { class: 'sub warn' }, `디자인에 없는 상태: ${r.missingInDesign.join(', ')}`) : null,
      r.warnings.length ? h('div', { class: 'sub' }, `걸러낸 답변: ${r.warnings.join(' · ')}`) : null,
      r.notes ? h('div', { class: 'sub' }, `메모: ${r.notes}`) : null,
      noteIn,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => doReview('approved') }, '승인'),
        h('button', { class: 'btn', type: 'button', onclick: () => doReview('inquiry') }, '기획 문의'),
        h('button', { class: 'btn', type: 'button', onclick: () => doReview('rejected') }, '제외')));

  const st = v.stats.high;
  const approvedCount = results.filter((x) => x.review.status === 'approved' || x.review.status === 'edited').length;
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h3', {}, '검토'),
      h('div', { class: 'row' },
        h('span', { class: 'sub' }, st && st.reviewed ? `"높음" 그대로 승인 ${st.approvedAsIs}/${st.reviewed}` : '"높음" 검토 전'),
        h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(gaps), onclick: () => { S.map.showGaps = !gaps; drawMapping(); } }, gaps ? 'TC별 보기' : `TC 없는 영역 ${v.coverage.uncovered.length}`),
        h('button', { class: 'btn small primary', type: 'button', disabled: !approvedCount, onclick: async () => {
          const out = await guard(() => api('POST', `/api/mapping/${pid}/apply`));
          if (!out) return;
          S.elements = await api('GET', '/api/elements');
          S.tcs = await api('GET', '/api/tcs');
          toast(`TC ${out.tcsUpdated.length}건 반영, 새 요소 ${out.elementsAdded.length}개 추가${out.skipped.length ? `, ${out.skipped.length}건 건너뜀` : ''}`);
          renderMapping(pid);
        } }, `승인한 ${approvedCount}건 반영`))),
    h('div', { class: 'map3' }, list, frameView, detail));
}

// ---------- TC 자동 작성 ----------
// ① 자료·범위 → ② 테스트 조건(검토) → ③ TC 초안(검토) → ④ 반영. 한 화면에 위에서 아래로 둔다
const TECH = { EP: '동등 분할', BVA: '경계값', DT: '결정표', ST: '상태 전이', EG: '오류 추정', UC: '유스케이스' };
const CTYPE = { positive: '정상', negative: '예외', boundary: '경계', permission: '권한', exception: '오류 처리' };
const GEN_REVIEW = { pending: ['s-Blocked', '검토 대기'], approved: ['s-Pass', '승인'], inquiry: ['s-Flaky', '기획 문의'], rejected: ['s-Fail', '제외'] };
const GEN_METHOD = { rules: '규칙 기반', 'claude-code': 'Claude Code' };
const RUNNABLE = { ok: ['s-Pass', '실행 가능'], 'needs-locator': ['s-Flaky', '식별자 필요'], invalid: ['s-Fail', '스텝 오류'], manual: ['s-Blocked', '스텝 직접 작성'] };
const EVID = { verified: ['s-Pass', '근거 원문 확인'], unverified: ['s-Flaky', '근거 대조 불가(PDF·이미지)'], form: ['s-Blocked', '근거: 조건표'], none: ['s-none', '근거 없음'] };
const tag = ([cls, text], title) => h('span', { class: `pill ${cls}`, title }, text);
const techLabel = (t) => String(t || '').split('+').map((x) => TECH[x] || x).join('+');

async function renderGenerate(pid) {
  if (!pid) return renderGenerateList();
  const v = await guard(() => api('GET', `/api/generate/${pid}`));
  if (!v) { location.hash = '#generate'; return; }
  S.gen = S.gen && S.gen.id === pid ? Object.assign(S.gen, { v }) : { id: pid, v, filter: 'all' };
  drawGenerate();
}

async function renderGenerateList() {
  const list = await api('GET', '/api/generate');
  const nameIn = h('input', { type: 'text', id: 'genName', placeholder: '예: 회원가입 v2.1 · 결제 정보 입력', style: 'flex:1;min-width:0' });
  app().replaceChildren(h('section', { class: 'card stack' },
    h('div', {}, h('h2', {}, 'TC 자동 작성'),
      h('div', { class: 'sub' }, '기획서·화면·입력 조건표에서 테스트 조건을 먼저 뽑아 검토하고, 승인한 조건만 TC 초안으로 만듭니다. 근거 인용은 원문과 대조하고, QA가 승인한 초안만 TC로 저장합니다.')),
    h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const p = await guard(() => api('POST', '/api/generate', { name: nameIn.value })); if (p) location.hash = `#generate/${p.id}`; } },
      nameIn, h('button', { class: 'btn primary', type: 'submit' }, '새로 만들기')),
    list.length ? h('div', { class: 'tbl' }, h('table', {},
      h('thead', {}, h('tr', {}, ['이름', '기획서', '화면', '조건', '초안', '반영'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((p) => h('tr', { class: 'clickable', tabindex: '0', onclick: () => { location.hash = `#generate/${p.id}`; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#generate/${p.id}`; } },
        h('td', {}, p.name), h('td', { class: 'num' }, p.specs), h('td', { class: 'num' }, p.frames), h('td', { class: 'num' }, p.conditions), h('td', { class: 'num' }, p.drafts), h('td', { class: 'num' }, p.applied))))))
      : h('div', { class: 'empty' }, '아직 없습니다. 이름을 넣고 새로 만드세요.'),
    h('div', { class: 'guide' }, h('b', {}, '작성 방법 두 가지'), h('ol', {},
      h('li', {}, '규칙 기반(무료): 입력 조건표로 동등 분할·경계값 TC와 데이터 행을 만들고, 텍스트 기획서에서 조건 문장과 모호한 문장을 찾습니다.'),
      h('li', {}, 'Claude Code(구독 안에서): 요청 파일을 만들어 Claude Code 대화창에 맡깁니다. PDF·이미지 기획서와 화면도 읽습니다. 고객사 자료는 외부 AI 전송이 허용되는지 먼저 확인하세요.')))));
}

function drawGenerate() {
  const { v } = S.gen;
  const pid = v.id;
  const refresh = (nv) => { if (nv) { S.gen.v = nv; drawGenerate(); } };
  // 화면에서 고친 설정을 먼저 저장하고 동작한다 (저장 버튼을 누르지 않아도 조건·초안이 최신 설정으로 만들어지게)
  const save = async () => {
    if (!S.gen.collect) return true;
    const nv = await guard(() => api('PUT', `/api/generate/${pid}`, S.gen.collect()));
    if (nv) S.gen.v = nv;
    return !!nv;
  };
  const call = async (method, url, body, msg, saveFirst) => {
    if (saveFirst && !(await save())) return null;
    const nv = await guard(() => api(method, `/api/generate/${pid}${url}`, body));
    if (nv && msg) toast(typeof msg === 'function' ? msg(nv) : msg);
    refresh(nv);
    return nv;
  };
  const y = window.scrollY;
  app().replaceChildren(genHeader(v), genMaterials(v, call, save), genConditions(v, call), genDrafts(v, call), genApply(v, call));
  window.scrollTo(0, y);
}

function genHeader(v) {
  const approvedC = v.conditions.filter((c) => c.review.status === 'approved').length;
  const approvedD = v.drafts.filter((d) => d.review.status === 'approved').length;
  const applied = v.drafts.filter((d) => d.appliedAs).length;
  const steps = [
    ['자료·범위', `기획서 ${v.specs.length} · 화면 ${v.frames.length}${v.formState.fields ? ` · 조건표 ${v.formState.fields}필드` : ''}`, v.specs.length + v.frames.length + v.formState.fields > 0],
    ['테스트 조건', v.conditions.length ? `${v.conditions.length}개 · 승인 ${approvedC}` : '아직 없음', approvedC > 0],
    ['TC 초안', v.drafts.length ? `${v.drafts.length}건 · 승인 ${approvedD}` : '아직 없음', approvedD > 0],
    ['반영', applied ? `TC ${applied}건 저장됨` : '아직 없음', applied > 0],
  ];
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('div', {}, h('a', { href: '#generate' }, '← 목록'), h('h2', {}, v.name)),
      v.lastRun ? h('span', { class: 'sub' }, `최근: ${GEN_METHOD[v.lastRun.method]} · ${v.lastRun.stage === 'conditions' ? '조건' : '초안'} · ${fmtTime(v.lastRun.at)}`) : null),
    h('ol', { class: 'stepper' }, steps.map(([t, d, done], i) => h('li', { class: done ? 'done' : '' },
      h('a', { href: `#generate/${v.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`gen-s${i + 1}`).scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        h('b', {}, `${i + 1}. ${t}`), h('span', { class: 'sub' }, d))))),
    v.lastRun && v.lastRun.warnings.length ? h('div', { class: 'errbox' }, v.lastRun.warnings.slice(0, 8).join('\n')) : null);
}

function genMaterials(v, call, save) {
  const pid = v.id;
  const f = v.form;
  const specInput = h('input', { type: 'file', id: 'genSpecFiles', multiple: true, hidden: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.txt,.md' });
  const frameInput = h('input', { type: 'file', id: 'genFrameFiles', multiple: true, hidden: true, accept: '.png,.jpg,.jpeg,.webp' });
  const upload = (kind) => async (e) => {
    if (!(await save())) return;
    for (const file of [...e.target.files]) {
      toast(`${file.name} 올리는 중…`);
      const data = await readFileB64(file).catch((err) => { toast(err.message, true); return null; });
      if (data) await call('POST', '/files', { kind, fileName: file.name, data });
    }
  };
  specInput.addEventListener('change', upload('spec'));
  frameInput.addEventListener('change', upload('frame'));
  const del = (fid) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': '삭제', title: '삭제', onclick: async () => { if (await save()) call('DELETE', `/files/${fid}`); } }, '✕');
  const figmaIn = h('input', { type: 'text', id: 'genFigma', placeholder: 'https://www.figma.com/design/...?node-id=...', value: v.figma ? v.figma.url : '', style: 'flex:1;min-width:0' });

  // 범위
  const chosen = new Set(v.scope.sections);
  const secBox = h('div', { class: 'tc-pick', style: 'max-height:220px' }, v.sections.map((sec) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: sec.key, checked: chosen.has(sec.key) }),
    h('span', { class: 'mono sub' }, sec.spec), h('span', {}, sec.title, h('span', { class: 'sub' }, ` · ${sec.chars}자`)))));
  const noteIn = h('textarea', { id: 'genScopeNote', rows: 2, placeholder: '이번에 다룰 기능 (예: 결제 정보 입력 화면의 입력 검증만. PDF 기획서는 이 설명으로 범위를 정합니다)' }, v.scope.note);

  // 입력 조건표
  const keys = (o) => Object.keys(o || {});
  const lists = [h('datalist', { id: 'gen-el' }, keys(S.elements.elements).map((k) => h('option', { value: k }, S.elements.elements[k].label))),
    h('datalist', { id: 'gen-sc' }, keys(S.elements.screens).map((k) => h('option', { value: k }, S.elements.screens[k].label)))];
  const inp = (id, value, ph, list) => h('input', { type: 'text', id, value: value || '', placeholder: ph, list, autocomplete: 'off' });
  const fName = inp('genFormName', f.name, '예: 결제 정보 입력');
  const fFlow = h('select', { id: 'genFlow' }, h('option', { value: '' }, '(없음)'), keys(S.flows).map((k) => h('option', { value: k, selected: k === f.flow }, `${S.flows[k].label} · ${k}`)));
  const fScreen = inp('genScreen', f.screen, 'screen.signup', 'gen-sc');
  const fSubmit = inp('genSubmit', f.submit, 'signup.submit', 'gen-el');
  const fError = inp('genError', f.error, 'signup.error', 'gen-el');
  const fKind = h('select', { id: 'genSuccKind' }, [['visible', '요소 노출'], ['url', '주소 포함'], ['text', '요소 문구']].map(([k, t]) => h('option', { value: k, selected: k === f.success.kind }, t)));
  const fTarget = inp('genSuccTarget', f.success.target, '요소 (예: signup.done)', 'gen-el');
  const fValue = inp('genSuccValue', f.success.value, '주소 조각 또는 문구');
  const fPrio = h('select', { id: 'genPrio' }, ['P1', 'P2', 'P3'].map((x) => h('option', { value: x, selected: x === f.priority }, x)));
  const plats = Object.keys(S.meta.platformLabels).map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p, checked: f.platforms.includes(p) }), PL(p)));
  const fText = h('textarea', { id: 'genFormText', class: 'mono', rows: 6, placeholder: `${v.formHeader}\n이메일\tsignup.email\t이메일\tY\t\t50\t\t이메일을 입력하세요\t이메일 형식이 아닙니다\t` }, f.text);
  const fPre = inp('genPre', f.precondition, '예: 로그인 상태');
  const prefixIn = inp('genPrefix', v.idPrefix, 'TC-GEN-');
  const exSel = [0, 1].map((i) => h('select', { 'aria-label': `팀 TC 예시 ${i + 1}` }, h('option', { value: '' }, i ? '(없음)' : '(자동으로 고름)'),
    S.tcs.filter((t) => t.automation !== '수동 유지').map((t) => h('option', { value: t.id, selected: v.examples[i] === t.id }, `${t.id} ${t.title}`))));

  S.gen.collect = () => ({
    scope: { sections: [...secBox.querySelectorAll('input:checked')].map((i) => i.value), note: noteIn.value },
    form: { name: fName.value, text: fText.value, flow: fFlow.value, screen: fScreen.value, submit: fSubmit.value, error: fError.value,
      success: { kind: fKind.value, target: fTarget.value, value: fValue.value }, priority: fPrio.value, precondition: fPre.value,
      platforms: plats.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value) },
    idPrefix: prefixIn.value, examples: exSel.map((s) => s.value).filter(Boolean),
  });
  const fst = v.formState;
  const newEls = Object.entries(fst.newElements);
  return h('section', { class: 'card stack', id: 'gen-s1' },
    h('h3', {}, '① 자료·범위'),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('b', {}, `기획서 ${v.specs.length}개`), h('label', { class: 'btn small', for: 'genSpecFiles' }, '기획서 올리기'), specInput),
        h('div', { class: 'sub' }, '텍스트(.txt/.md)는 "# 제목"으로 절을 나눠 범위를 고를 수 있고, 인용을 원문과 대조합니다. PDF·이미지는 Claude Code로만 읽습니다.'),
        v.specs.length ? h('ul', { class: 'checks' }, v.specs.map((s) => h('li', { style: 'grid-template-columns:28px minmax(0,1fr) auto' }, h('span', { class: 'mono sub' }, s.id), h('span', {}, s.name, h('span', { class: 'sub' }, ` · ${s.kind}`)), del(s.id)))) : null,
        v.sections.length ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'sub' }, `범위: 다룰 절을 고르세요 (고르지 않으면 전체). 한 번에 한 기능씩 나눠야 결과가 정확합니다.`), secBox) : null,
        h('label', { class: 'field' }, '범위 설명', noteIn)),
      h('div', { class: 'stack' },
        h('div', { class: 'row between' }, h('b', {}, `화면 ${v.frames.length}개`), h('label', { class: 'btn small', for: 'genFrameFiles' }, '캡처 올리기'), frameInput),
        h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); if (!(await save())) return; toast('피그마에서 프레임을 가져오는 중…'); await call('POST', '/figma', { url: figmaIn.value }, (nv) => `프레임 ${nv.added}개를 가져왔습니다`); } },
          figmaIn, h('button', { class: 'btn small', type: 'submit' }, '피그마에서 가져오기')),
        v.frames.length ? h('div', { class: 'thumbs' }, v.frames.map((fr) => h('figure', {},
          h('img', { src: `/generate-files/${pid}/${fr.file}`, alt: fr.name, loading: 'lazy' }),
          h('figcaption', { class: 'row between' }, h('span', {}, h('span', { class: 'mono sub' }, `${fr.id} `), fr.name), del(fr.id))))) : h('div', { class: 'sub' }, '화면은 Claude Code 요청에 함께 넣습니다. 에러·팝업 같은 상태 화면도 넣으세요.'))),
    h('div', { class: 'stack form-box' },
      h('div', { class: 'row between' }, h('b', {}, '입력 조건표 (선택)'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { if (!fText.value.trim()) fText.value = `${v.formHeader}\n`; else if (!fText.value.startsWith('필드')) fText.value = `${v.formHeader}\n${fText.value}`; fText.focus(); } }, '머리글 넣기')),
      h('div', { class: 'sub' }, '입력 폼의 필드 규칙을 적으면 동등 분할·경계값(최소-1, 최소, 최대, 최대+1) 조건과 데이터 행 TC를 만듭니다. 엑셀에서 표를 복사해 붙여넣어도 됩니다. 요소 맵에 없는 이름은 새 요소로 추가됩니다.'),
      h('div', { class: 'gen-form' },
        h('label', { class: 'field' }, '폼 이름', fName), h('label', { class: 'field' }, '진입: 공통 흐름', fFlow),
        h('label', { class: 'field' }, '진입: 화면', fScreen), h('label', { class: 'field' }, '우선순위(정상 제출)', fPrio),
        h('label', { class: 'field' }, '제출 버튼', fSubmit), h('label', { class: 'field' }, '오류 문구 요소', fError),
        h('label', { class: 'field' }, '성공 확인 방법', fKind), h('label', { class: 'field' }, '성공 확인 요소', fTarget),
        h('label', { class: 'field' }, '성공 확인 주소 조각·문구', fValue),
        h('label', { class: 'field wide' }, '사전조건', fPre),
        h('div', { class: 'wide row' }, h('span', { class: 'sub' }, '플랫폼'), plats),
        h('label', { class: 'field wide' }, '조건표', fText)),
      fst.errors.length && f.text.trim() ? h('div', { class: 'errbox' }, fst.errors.join('\n')) : null,
      newEls.length ? h('div', { class: 'notice' }, `요소 맵에 없어 새로 만들 요소 ${newEls.length}개: ${newEls.map(([k, e]) => `${k}(${e.label})`).join(', ')} — 반영 후 요소 맵에서 식별자를 채웁니다`) : null),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'TC ID 접두어', prefixIn),
      h('label', { class: 'field' }, '팀 TC 예시 1 (Claude Code 형식 맞춤)', exSel[0]),
      h('label', { class: 'field' }, '팀 TC 예시 2', exSel[1]),
      h('button', { class: 'btn primary', type: 'button', style: 'align-self:end', onclick: async () => { if (await save()) { toast('저장했습니다'); drawGenerate(); } } }, '저장')),
    lists);
}

function genModes(v, call, stage) {
  const cc = v.claudeCode && v.claudeCode.stage === stage ? v.claudeCode : null;
  const ruleUrl = stage === 'conditions' ? '/rules/conditions' : '/rules/drafts';
  const mode = (title, cost, desc, button) => h('div', { class: 'mode' }, h('div', { class: 'row between' }, h('b', {}, title), h('span', { class: 'pill s-Pass' }, cost)), h('div', { class: 'sub' }, desc), h('div', { class: 'row' }, button));
  return h('div', { class: 'stack' },
    h('div', { class: 'modes', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' },
      mode('규칙 기반', '무료', stage === 'conditions'
        ? '입력 조건표로 동등 분할·경계값 조건을, 텍스트 기획서에서 "~시·~경우·~하면·이상·최대" 같은 조건 문장과 모호한 문장(기획 문의)을 뽑습니다.'
        : '승인한 조건표 조건은 실행 가능한 TC와 데이터 행으로, 기획서 조건은 원문만 있는 초안으로 만듭니다.',
      h('button', { class: 'btn primary', type: 'button', onclick: () => call('POST', ruleUrl, null, stage === 'conditions' ? (nv) => `조건 ${nv.conditions.length}개` : (nv) => `초안 ${nv.drafts.length}건`, true) }, stage === 'conditions' ? '조건 뽑기' : 'TC 초안 만들기')),
      mode('Claude Code', '구독 안에서', stage === 'conditions'
        ? '범위 안의 기획서·화면을 읽고 기법(EP·BVA·결정표·상태 전이·오류 추정)별 조건과 기획 문의를 찾습니다. PDF·이미지도 읽습니다.'
        : '승인한 조건만 넘겨 TC 초안을 만듭니다. 팀 TC 예시 형식을 따르고, 스텝이 틀리면 AutoTC가 자연어 절차에서 다시 변환합니다.',
      h('button', { class: 'btn', type: 'button', onclick: () => call('POST', '/claude-code/export', { stage }, 'Claude Code 요청 파일을 만들었습니다', true) }, '요청 파일 만들기'))),
    cc ? h('div', { class: 'notice stack' },
      h('b', {}, `Claude Code 요청 · ${stage === 'conditions' ? '1단계 조건' : `2단계 초안 (조건 ${cc.conditionIds.length}개)`} · ${fmtTime(cc.at)}`),
      h('div', {}, 'Claude Code 대화창에 아래 문장을 붙여넣으세요. 끝나면 "응답 가져오기"를 누릅니다.'),
      h('pre', { style: 'white-space:pre-wrap' }, v.prompt),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => copyText(v.prompt) }, '요청 문장 복사'),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => call('POST', '/claude-code/import', null, (nv) => `${nv.imported}건을 가져왔습니다`) }, '응답 가져오기'))) : null);
}

function genConditions(v, call) {
  const put = (c, body, msg) => call('PUT', `/conditions/${c.id}`, body, msg);
  const filter = S.gen.filter;
  const shown = v.conditions.filter((c) => filter === 'all' || (filter === 'open' ? c.review.status === 'pending' : filter === 'approved' ? c.review.status === 'approved' : ['rejected', 'inquiry'].includes(c.review.status)));
  const pending = v.conditions.filter((c) => c.review.status === 'pending').length;
  const sel = (options, value, onchange, label) => h('select', { 'aria-label': label, onchange }, Object.entries(options).map(([k, t]) => h('option', { value: k, selected: k === value }, t)));
  const evidenceCell = (c) => {
    const ev = c.evidence || [];
    const lv = ev.some((e) => e.verified === true) ? EVID.verified : ev.length ? EVID.unverified : c.source === 'form' ? EVID.form : EVID.none;
    return h('div', { class: 'stack', style: 'gap:2px' }, tag(lv, ev.map((e) => `${e.policyId ? `[${e.policyId}] ` : ''}${e.quote}`).join('\n') || undefined),
      ev[0] ? h('span', { class: 'sub quote' }, `"${ev[0].quote}"`) : null,
      c.assumption ? h('span', { class: 'sub warn' }, `가정: ${c.assumption}`) : null);
  };
  const addHint = async (c) => {
    const body = S.gen.collect();
    const text = body.form.text.trim() ? body.form.text.replace(/\s+$/, '') : v.formHeader;
    body.form.text = `${text}\n${c.hint}`;
    const nv = await guard(() => api('PUT', `/api/generate/${v.id}`, body));
    if (nv) { toast('조건표에 한 줄 넣었습니다. 요소·오류 문구를 채우고 다시 조건을 뽑으세요'); S.gen.v = nv; drawGenerate(); document.getElementById('genFormText').focus(); }
  };
  const rows = shown.map((c) => h('tr', { class: c.review.status === 'rejected' ? 'dim' : '' },
    h('td', { class: 'mono sub' }, c.id),
    h('td', {}, h('input', { type: 'text', value: c.text, 'aria-label': `${c.id} 조건`, style: 'width:100%', onchange: (e) => put(c, { edits: { text: e.target.value } }, '조건을 고쳤습니다') }),
      h('div', { class: 'sub' }, `${{ form: '조건표', spec: '기획서 규칙', 'claude-code': 'Claude Code' }[c.source]}${c.section ? ` · ${c.section}` : ''}`,
        c.hint ? h('button', { class: 'linkish', type: 'button', onclick: () => addHint(c) }, ' · 조건표에 경계 넣기') : null)),
    h('td', {}, sel(TECH, c.technique, (e) => put(c, { edits: { technique: e.target.value } }), `${c.id} 기법`)),
    h('td', {}, sel(CTYPE, c.type, (e) => put(c, { edits: { type: e.target.value } }), `${c.id} 유형`)),
    h('td', {}, sel({ P1: 'P1', P2: 'P2', P3: 'P3' }, c.priority, (e) => put(c, { edits: { priority: e.target.value } }), `${c.id} 우선순위`)),
    h('td', { style: 'max-width:260px' }, evidenceCell(c)),
    h('td', {}, h('div', { class: 'stack', style: 'gap:4px' }, tag(GEN_REVIEW[c.review.status]),
      h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
        h('button', { class: 'btn small', type: 'button', title: '승인', disabled: c.review.status === 'approved', onclick: () => put(c, { status: 'approved' }) }, '승인'),
        h('button', { class: 'btn small', type: 'button', title: '기획 문의', disabled: c.review.status === 'inquiry', onclick: () => put(c, { status: 'inquiry' }) }, '문의'),
        h('button', { class: 'btn small', type: 'button', title: '제외', disabled: c.review.status === 'rejected', onclick: () => put(c, { status: 'rejected' }) }, '제외'))))));

  const cov = v.coverage;
  const qText = v.questions.map((q, i) => `${i + 1}. ${q.text}${q.quote ? `\n   원문(${q.specName}): "${q.quote}"` : ''}`).join('\n');
  const dist = (o, labels) => Object.entries(o).map(([k, n]) => `${labels[k] || k} ${n}`).join(' · ') || '-';
  return h('section', { class: 'card stack', id: 'gen-s2' },
    h('h3', {}, '② 테스트 조건'),
    h('div', { class: 'sub' }, '무엇을 확인할지 먼저 정합니다. 조건을 승인해야 TC 초안을 만들 수 있습니다 (시나리오 검토 후 상세 작성).'),
    genModes(v, call, 'conditions'),
    v.conditions.length ? h('div', { class: 'stack' },
      h('div', { class: 'row between' },
        h('div', { class: 'chips' }, [['all', `전체 ${v.conditions.length}`], ['open', `검토 대기 ${pending}`], ['approved', '승인'], ['other', '문의·제외']].map(([k, t]) =>
          h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === k), onclick: () => { S.gen.filter = k; drawGenerate(); } }, t))),
        h('button', { class: 'btn small primary', type: 'button', disabled: !pending, onclick: () => call('POST', '/conditions/review', { status: 'approved' }, (nv) => `${nv.changed}개를 승인했습니다`) }, `검토 대기 ${pending}개 모두 승인`)),
      h('div', { class: 'tbl' }, h('table', { class: 'cond-tbl' },
        h('thead', {}, h('tr', {}, ['ID', '조건', '기법', '유형', '우선', '근거', '검토'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 7, class: 'sub' }, '해당하는 조건이 없습니다'))))),
      h('div', { class: 'grid2' },
        h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('b', {}, `기획 문의 ${v.questions.length}건`),
          v.questions.length ? h('button', { class: 'btn small', type: 'button', onclick: () => copyText(qText) }, '문의 목록 복사') : null),
        v.questions.length ? h('ul', { class: 'checks' }, v.questions.map((q) => h('li', { style: 'grid-template-columns:minmax(0,1fr)' }, h('span', {}, q.text, q.quote ? h('div', { class: 'sub quote' }, `"${q.quote}"`) : null))))
          : h('div', { class: 'sub' }, '모호한 문장을 찾지 못했습니다')),
        h('div', { class: 'stack' }, h('b', {}, '커버리지'),
          cov.policies.length ? h('div', { class: 'chips' }, cov.policies.map((x) => h('span', { class: `pill ${x.conditions ? 's-Pass' : 's-none'}`, title: `조건 ${x.conditions}개` }, `${x.id} ${x.conditions}`)))
            : h('div', { class: 'sub' }, '기획서에서 정책 번호(예: ORD-02)를 찾지 못했습니다'),
          cov.uncovered.length ? h('div', { class: 'sub warn' }, `조건이 없는 정책: ${cov.uncovered.join(', ')}`) : null,
          h('div', { class: 'sub' }, `승인한 조건의 기법: ${dist(cov.techniques, TECH)}`),
          h('div', { class: 'sub' }, `유형: ${dist(cov.types, CTYPE)}`),
          cov.types.positive && Object.values(cov.types).reduce((a, b) => a + b, 0) === cov.types.positive ? h('div', { class: 'sub warn' }, '정상 조건만 있습니다. 예외·경계 조건을 확인하세요') : null))) : null);
}

function genDraftCard(v, d, call) {
  const ck = d.checks;
  const put = (body, msg) => call('PUT', `/drafts/${d.id}`, body, msg);
  const noteIn = h('input', { type: 'text', 'aria-label': `${d.id} 메모`, placeholder: '제외 사유 또는 기획 문의 내용', value: d.review.note || '', style: 'flex:1;min-width:0' });
  const badges = ck ? [
    tag(RUNNABLE[ck.runnable], ck.problems.join('\n') || undefined),
    tag(EVID[ck.evidence]),
    ck.newElements ? tag(['s-Flaky', `새 요소 ${ck.newElements}`], Object.entries(d.newElements).map(([k, e]) => `${k} ${e.label}`).join('\n')) : null,
    ck.weak ? tag(['s-Fail', '약한 기대결과'], '확인하는 스텝이 없거나 기대결과가 "정상 동작"처럼 막연합니다') : null,
    ck.duplicates.length ? tag(['s-Fail', `중복 의심 ${ck.duplicates[0].id} ${Math.round(ck.duplicates[0].score * 100)}%`], ck.duplicates.map((x) => `${x.id} ${x.title} (${Math.round(x.score * 100)}%)`).join('\n')) : null,
    ck.assumptions.length ? tag(['s-Flaky', `가정 ${ck.assumptions.length}`], ck.assumptions.join('\n')) : null,
  ] : [];
  const conds = d.conditionIds.map((c) => v.conditions.find((x) => x.id === c)).filter(Boolean);
  const rowKeys = d.dataSets ? [...new Set(d.dataSets.flatMap((r) => Object.keys(r.values)))] : [];
  return h('article', { class: `draft${d.appliedAs ? ' applied' : ''}${d.review.status === 'rejected' ? ' dim' : ''}` },
    h('div', { class: 'row between' },
      h('div', { class: 'stack', style: 'gap:2px;flex:1;min-width:0' },
        h('span', { class: 'mono sub' }, `${d.id} · ${GEN_METHOD[d.method]} · ${techLabel(d.technique)} · 조건 ${d.conditionIds.join(', ') || '-'}`),
        d.appliedAs ? h('b', {}, d.title) : h('input', { type: 'text', value: d.title, 'aria-label': `${d.id} 제목`, style: 'width:100%;font-weight:600', onchange: (e) => put({ edits: { title: e.target.value } }, '제목을 고쳤습니다') })),
      h('div', { class: 'row' },
        d.appliedAs ? null : h('select', { 'aria-label': `${d.id} 우선순위`, onchange: (e) => put({ edits: { priority: e.target.value } }) }, ['P1', 'P2', 'P3'].map((x) => h('option', { value: x, selected: x === d.priority }, x))),
        d.appliedAs ? h('a', { class: 'pill s-Pass', href: `#tcs/${encodeURIComponent(d.appliedAs)}` }, `${d.appliedAs}로 반영됨`) : tag(GEN_REVIEW[d.review.status]))),
    badges.length ? h('div', { class: 'chips' }, badges) : null,
    h('div', { class: 'sub' }, `${d.platforms.map(PL).join(', ')}${d.precondition ? ` · 사전조건: ${d.precondition}` : ''}`),
    h('div', { class: 'grid2' },
      d.lines.length ? h('ol', { class: 'plain-steps' }, d.lines.map((l) => h('li', {}, l)))
        : h('div', { class: 'stack', style: 'gap:4px' }, h('div', { class: 'sub' }, '절차 (원문)'), h('pre', { class: 'srcbox' }, d.source.steps || '(비어 있음)')),
      h('div', { class: 'stack', style: 'gap:6px' },
        d.dataSets ? h('div', { class: 'tbl' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, `데이터 행 ${d.dataSets.length}`), rowKeys.map((k) => h('th', { class: 'mono' }, k)))),
          h('tbody', {}, d.dataSets.map((r) => h('tr', {}, h('td', {}, r.name), rowKeys.map((k) => h('td', { class: 'mono' }, r.values[k] === '' ? '(빈 값)' : r.values[k])))))))
          : null,
        h('div', { class: 'sub' }, '기대결과'), h('pre', { class: 'srcbox' }, d.source.expected || '(비어 있음)'),
        conds.length ? h('div', { class: 'sub' }, `다루는 조건: ${conds.map((c) => `${c.id} ${c.text}`).join(' / ')}`) : null)),
    ck && (ck.problems.length || d.notes.length || ck.assumptions.length) ? h('ul', { class: 'sub notes' },
      ck.problems.map((x) => h('li', { class: 'warn' }, x)), d.notes.map((x) => h('li', {}, x)), ck.assumptions.map((x) => h('li', {}, `가정: ${x}`))) : null,
    d.appliedAs ? null : h('div', { class: 'row' }, noteIn,
      h('button', { class: 'btn primary small', type: 'button', disabled: d.review.status === 'approved', onclick: () => put({ status: 'approved', note: noteIn.value }) }, '승인'),
      h('button', { class: 'btn small', type: 'button', onclick: () => put({ status: 'inquiry', note: noteIn.value }) }, '기획 문의'),
      h('button', { class: 'btn small', type: 'button', onclick: () => put({ status: 'rejected', note: noteIn.value }) }, '제외')));
}

function genDrafts(v, call) {
  const st = Object.entries(v.stats).map(([m, x]) => `${GEN_METHOD[m]} ${x.approved}/${x.total} 승인${x.rejected ? ` · 제외 ${x.rejected}` : ''}`).join(' · ');
  // 검토해도 순서가 바뀌지 않게 반영한 것만 뒤로 보낸다 (누른 카드가 다른 자리로 옮겨 가지 않도록)
  const drafts = v.drafts.slice().sort((a, b) => Number(!!a.appliedAs) - Number(!!b.appliedAs));
  return h('section', { class: 'card stack', id: 'gen-s3' },
    h('div', { class: 'row between' }, h('h3', {}, '③ TC 초안'), st ? h('span', { class: 'sub' }, `채택률: ${st}`) : null),
    h('div', { class: 'sub' }, '배지를 보고 검토하세요: 실행 가능·식별자 필요·스텝 오류, 근거, 새 요소, 약한 기대결과, 중복 의심, 가정. AI 초안은 신입 QA가 쓴 초안처럼 다룹니다.'),
    genModes(v, call, 'drafts'),
    drafts.length ? h('div', { class: 'stack' }, drafts.map((d) => genDraftCard(v, d, call))) : h('div', { class: 'empty' }, '아직 초안이 없습니다. ② 에서 조건을 승인한 뒤 초안을 만드세요.'));
}

function genApply(v, call) {
  const todo = v.drafts.filter((d) => d.review.status === 'approved' && !d.appliedAs);
  const newEls = [...new Set(todo.flatMap((d) => Object.keys(d.newElements || {})))];
  const manual = todo.filter((d) => !d.steps.length).length;
  return h('section', { class: 'card stack', id: 'gen-s4' },
    h('h3', {}, '④ 반영'),
    todo.length ? h('div', { class: 'stack' },
      h('div', {}, `승인한 초안 ${todo.length}건을 TC로 저장합니다: `, h('span', { class: 'mono' }, v.nextIds.join(', '))),
      h('div', { class: 'sub' }, `태그 generated, 출처(프로젝트·초안·방법·조건·승인 시각)를 TC에 남깁니다.${manual ? ` 스텝이 없는 ${manual}건은 "수동 유지"로 저장됩니다.` : ''}`),
      newEls.length ? h('div', { class: 'notice' }, `새 요소 ${newEls.length}개를 요소 맵에 추가합니다: ${newEls.join(', ')}. 반영 후 요소 맵 화면에서 식별자를 채워야 실행됩니다.`) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const out = await guard(() => api('POST', `/api/generate/${v.id}/apply`));
        if (!out) return;
        [S.tcs, S.elements] = await Promise.all([api('GET', '/api/tcs'), api('GET', '/api/elements')]);
        toast(`TC ${out.tcsAdded.length}건을 저장했습니다${out.elementsAdded.length ? `, 새 요소 ${out.elementsAdded.length}개` : ''}`);
        renderGenerate(v.id);
      } }, `TC ${todo.length}건 반영`)))
      : h('div', { class: 'sub' }, v.drafts.some((d) => d.appliedAs) ? '승인한 초안은 모두 반영했습니다. 저장된 TC는 TC 편집기에서 고치고 실행 현황에서 돌립니다.' : '③ 에서 초안을 승인하면 여기서 TC로 저장합니다.'));
}

// ---------- 설정 ----------
async function renderSettings() {
  const [cfg, meta, st] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/settings/devices'), api('GET', '/api/ai/settings')]);
  const d = JSON.parse(JSON.stringify(cfg));
  d.ai = d.ai || { model: 'claude-opus-5-5', effort: 'high' };
  d.android = d.android || {};
  d.ios = d.ios || {};
  let dirty = false;
  const dirtyEl = h('span', { class: 'sub warn', hidden: true }, '저장하지 않은 변경 있음');
  const mark = () => { dirty = true; dirtyEl.hidden = false; };
  window.onbeforeunload = () => (dirty ? true : undefined);

  // 점 표기 경로로 값을 읽고 쓴다 (예: "pc.viewport.width")
  const getP = (p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), d);
  const setP = (p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((o, k) => (o[k] = o[k] || {}), d)[last] = v; };
  const field = (label, p, { type = 'text', hint, scale = 1, placeholder, wide } = {}) => h('label', { class: `field${wide ? ' wide' : ''}` }, label,
    h('input', { type, id: `cfg-${p}`, value: getP(p) === undefined ? '' : String(type === 'number' ? Math.round((getP(p) / scale) * 1000) / 1000 : getP(p)), placeholder, oninput: (e) => {
      // 초 → 밀리초처럼 키우는 값은 정수로, % → 비율처럼 줄이는 값은 그대로 둔다
      const n = Number(e.target.value) * scale;
      setP(p, type === 'number' ? (scale >= 1 ? Math.round(n) : n) : e.target.value);
      mark();
    } }),
    hint ? h('span', { class: 'sub' }, hint) : null);
  const select = (label, p, options) => h('label', { class: 'field' }, label,
    h('select', { id: `cfg-${p}`, onchange: (e) => { setP(p, e.target.value); mark(); } }, options.map(([v, t]) => h('option', { value: v, selected: getP(p) === v }, t))));

  // 대상 사이트
  const inspectOut = h('div', { class: 'stack' });
  const attrInput = () => document.getElementById('cfg-testIdAttribute');
  const inspect = async () => {
    inspectOut.replaceChildren(h('span', { class: 'sub' }, '브라우저로 여는 중… (최대 20초)'));
    const r = await guard(() => api('POST', '/api/settings/inspect', { url: d.baseURL }));
    if (!r) { inspectOut.replaceChildren(); return; }
    inspectOut.replaceChildren(
      h('div', { class: r.ok ? 'notice' : 'errbox' }, r.message),
      r.attributes.length ? h('div', { class: 'row' }, h('span', { class: 'sub' }, '이 페이지에서 찾은 식별자 속성 (눌러서 선택):'),
        r.attributes.map((a) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(d.testIdAttribute === a.name), onclick: () => {
          d.testIdAttribute = a.name; attrInput().value = a.name; mark();
          inspectOut.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.textContent.startsWith(`${a.name} `))));
        } }, `${a.name} ${a.count}개`))) : (r.ok ? h('div', { class: 'sub warn' }, '테스트용 식별자 속성을 찾지 못했습니다. 개발팀에 data-testid 부여를 요청하거나 요소 맵에서 CSS·텍스트 방식으로 지정하세요') : null));
  };
  const siteCard = h('section', { class: 'card stack' },
    h('h3', {}, '대상 사이트'),
    h('div', { class: 'form-grid' },
      field('프로젝트 이름', 'project'),
      field('대상 사이트 주소', 'baseURL', { placeholder: 'https://qa.example.com' }),
      field('환경', 'env', { placeholder: 'qa / stg' }),
      field('식별자 속성', 'testIdAttribute', { placeholder: 'data-testid' }),
      field('API 주소 (선택)', 'apiBaseURL', { placeholder: '비우면 대상 사이트 주소', hint: 'API 액션의 "GET /경로"가 이 주소 뒤에 붙습니다' }),
      field('화면 비교 허용 차이 (%)', 'visual.maxDiffPixelRatio', { type: 'number', scale: 0.01, hint: '기준 이미지와 다른 픽셀이 이 비율 이하면 통과' })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: inspect }, '접속 확인'),
      h('span', { class: 'sub' }, '주소로 접속해 응답과, 요소 식별에 쓸 수 있는 속성(data-testid 등)을 찾아봅니다')),
    inspectOut,
    h('div', { class: 'sub' }, '주소를 바꾸면 요소 맵의 화면 경로와 식별자, TC도 그 사이트에 맞게 바꿔야 합니다. 지금 들어 있는 예시는 saucedemo 전용입니다.'));

  // 기기
  const desktops = meta.devices.filter((x) => !x.mobile);
  const mobiles = meta.devices.filter((x) => x.mobile);
  const chosen = new Set(d.mw.devices);
  const mwSearch = h('input', { type: 'text', id: 'mwSearch', placeholder: '기기 찾기 (예: Galaxy, iPhone)', style: 'max-width:260px' });
  const mwList = h('div', { class: 'tc-pick', style: 'max-height:220px' });
  const mwCount = h('span', { class: 'sub' });
  const drawMw = () => {
    const q = mwSearch.value.trim().toLowerCase();
    mwCount.textContent = `MW 기기 프리셋 · ${chosen.size}개 선택 · 고른 기기마다 같은 TC가 한 번씩 실행됩니다`;
    // 고른 기기를 맨 위에 둔다
    const shown = mobiles.filter((m) => chosen.has(m.name) || !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => Number(chosen.has(b.name)) - Number(chosen.has(a.name)));
    mwList.replaceChildren(...shown.map((m) => h('label', { class: 'check', style: 'grid-template-columns:18px minmax(0,1fr) auto' },
      h('input', { type: 'checkbox', checked: chosen.has(m.name), onchange: (e) => { if (e.target.checked) chosen.add(m.name); else chosen.delete(m.name); d.mw.devices = mobiles.map((x) => x.name).filter((n) => chosen.has(n)); mark(); mwCount.textContent = `MW 기기 프리셋 · ${chosen.size}개 선택 · 고른 기기마다 같은 TC가 한 번씩 실행됩니다`; } }),
      h('span', {}, m.name, h('span', { class: 'sub' }, ` ${m.width}×${m.height}`)),
      h('span', { class: m.installed ? 'sub' : 'sub warn' }, m.installed ? m.browser : `${m.browser} 설치 필요`))));
  };
  mwSearch.addEventListener('input', drawMw);
  drawMw();
  const devCard = h('section', { class: 'card stack' },
    h('h3', {}, '기기'),
    h('div', { class: 'form-grid' },
      select('PC 브라우저', 'pc.device', desktops.map((x) => [x.name, `${x.name}${x.installed ? '' : ' (설치 필요)'}`])),
      field('해상도 너비', 'pc.viewport.width', { type: 'number' }),
      field('해상도 높이', 'pc.viewport.height', { type: 'number' })),
    h('div', { class: 'row between' }, mwCount, mwSearch),
    mwList,
    h('div', { class: 'sub' }, '"설치 필요" 브라우저는 터미널에서 npx playwright install webkit (또는 firefox)으로 설치합니다.'));

  const appCard = h('section', { class: 'card stack' },
    h('h3', {}, '앱'),
    h('div', { class: 'form-grid' },
      field('안드로이드 패키지명', 'android.appId', { placeholder: 'com.example.shop' }),
      field('APK 경로 (선택)', 'android.apkPath', { placeholder: 'builds/app-qa.apk' }),
      field('기기 시리얼 (선택)', 'android.serial', { placeholder: '여러 대일 때' }),
      field('아이폰 번들 ID', 'ios.appId', { placeholder: 'com.example.shop' }),
      field('Mac 에이전트 주소', 'ios.agentUrl', { placeholder: 'http://192.168.0.24:4723', wide: true })));

  const runCard = h('section', { class: 'card stack' },
    h('h3', {}, '실행'),
    h('div', { class: 'form-grid' },
      field('실패 시 재시도', 'run.retries', { type: 'number', hint: '0~3회. 재시도에서 통과하면 Flaky' }),
      field('동시 실행 수', 'run.workers', { type: 'number', hint: 'PC·MW 브라우저 수' }),
      field('TC 제한 시간 (초)', 'run.timeoutMs', { type: 'number', scale: 1000 }),
      field('앱 TC 제한 시간 (초)', 'run.mobileTimeoutMs', { type: 'number', scale: 1000 }),
      field('동작 대기 (초)', 'run.actionTimeoutMs', { type: 'number', scale: 1000, hint: '요소가 나타나길 기다리는 시간' }),
      field('확인 대기 (초)', 'run.expectTimeoutMs', { type: 'number', scale: 1000 })));

  const exitCard = h('section', { class: 'card stack' },
    h('h3', {}, '종료 기준 · Flaky 격리'),
    h('div', { class: 'form-grid' },
      field('P1 Fail 허용 건수', 'exitCriteria.p1FailMax', { type: 'number' }),
      field('미해결 Critical 결함', 'exitCriteria.criticalOpenMax', { type: 'number' }),
      field('Flaky 비율 상한 (%)', 'exitCriteria.flakyRateMax', { type: 'number', scale: 0.01 }),
      field('Blocked 허용 건수', 'exitCriteria.blockedMax', { type: 'number' }),
      field('격리 판단: 최근 실행 수', 'quarantine.window', { type: 'number' }),
      field('격리 판단: Flaky 횟수', 'quarantine.flakyThreshold', { type: 'number', hint: '최근 실행 중 이 횟수 이상 Flaky면 격리' })),
    h('div', { class: 'sub' }, '종료 기준은 실행 현황의 "종료 기준 충족" 판정과 CI 성공·실패에 쓰입니다.'));

  const aiCard = h('section', { class: 'card stack' },
    h('h3', {}, 'AI (영역 매핑)'),
    h('div', { class: 'form-grid' },
      select('모델', 'ai.model', meta.models.map((m) => [m, m])),
      select('생각 깊이', 'ai.effort', meta.efforts.map((x) => [x, x]))),
    h('div', { class: 'sub' }, '기본값은 claude-opus-5-5 · high입니다. 깊이를 낮추면 비용과 시간이 줄지만 매핑 정확도가 떨어질 수 있습니다.'));

  d.roi = d.roi || {};
  const roiCard = h('section', { class: 'card stack' },
    h('h3', {}, 'ROI 계산 기준'),
    h('div', { class: 'form-grid' },
      field('TC 수동 실행 기본 시간 (분)', 'roi.manualMinutesDefault', { type: 'number', hint: 'TC에 수동 실행 시간이 없을 때' }),
      field('구축 시간 (시간)', 'roi.setupHours', { type: 'number', hint: '도구·환경·프레임워크 준비' }),
      field('TC 하나 자동화 (분)', 'roi.authorMinutesPerTc', { type: 'number' }),
      field('스크립트 수정 하나 (분)', 'roi.fixMinutesPerIssue', { type: 'number', hint: 'AUT 이슈 하나당' }),
      field('실패 분석 하나 (분)', 'roi.analysisMinutesPerFailure', { type: 'number', hint: 'Fail·Flaky 결과 하나당' })),
    h('div', { class: 'sub' }, '품질 지표 화면의 ROI = 절감 시간 ÷ 투자 시간 (ISTQB CT-TAS 5.1). 실제 팀 기록으로 바꿀수록 정확해집니다.'));

  const save = async () => {
    // 비율 입력은 %에서 바꾼 값이라 소수 둘째 자리로 맞춘다
    d.exitCriteria.flakyRateMax = Math.round(Number(getP('exitCriteria.flakyRateMax')) * 100) / 100;
    if (d.visual) d.visual.maxDiffPixelRatio = Math.round(Number(d.visual.maxDiffPixelRatio) * 10000) / 10000;
    const saved = await guard(() => api('PUT', '/api/config', d));
    if (!saved) return;
    dirty = false;
    S.config = saved;
    document.getElementById('projName').textContent = `${saved.project} · ${saved.env} · v${S.meta.version}`;
    toast('설정을 저장했습니다');
    renderSettings();
  };
  const bar = h('section', { class: 'card row between' },
    h('div', {}, h('h2', {}, '설정'), h('div', { class: 'sub' }, 'data/config.json에 저장됩니다. 다음 실행부터 적용됩니다.')),
    h('div', { class: 'row' }, dirtyEl, h('button', { class: 'btn', type: 'button', onclick: () => { dirty = false; renderSettings(); } }, '되돌리기'), h('button', { class: 'btn primary', type: 'button', onclick: save }, '저장')));
  app().replaceChildren(bar, siteCard, await secretsCard(), devCard, appCard, runCard, exitCard, roiCard, aiCard, aiSettingsCard(st, () => renderSettings()));
}

// 비밀값: 값은 화면에 다시 보여주지 않는다. 테스트 데이터에는 {"secret": "이름"}으로만 둔다
async function secretsCard() {
  const list = await api('GET', '/api/secrets');
  const body = h('div', { class: 'stack' });
  const draw = (items) => {
    const name = h('input', { type: 'text', placeholder: '이름 (예: QA_ADMIN_PASSWORD)', 'aria-label': '비밀값 이름', style: 'max-width:240px' });
    const value = h('input', { type: 'password', placeholder: '값', 'aria-label': '비밀값 값', autocomplete: 'new-password', style: 'max-width:240px' });
    const saveOne = async (n, v) => {
      const out = await guard(() => api('PUT', `/api/secrets/${encodeURIComponent(n)}`, { value: v }));
      if (out) { toast(`${n} 저장했습니다`); draw(out); }
    };
    body.replaceChildren(
      items.length ? h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['이름', '쓰는 곳', '상태', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, items.map((s) => {
          const v = h('input', { type: 'password', placeholder: s.source ? '바꿀 값' : '값 입력', 'aria-label': `${s.name} 값`, autocomplete: 'new-password', style: 'max-width:180px' });
          return h('tr', {},
            h('td', { class: 'mono' }, s.name),
            h('td', { class: 'sub' }, s.usedBy.length ? s.usedBy.join(', ') : '테스트 데이터에서 안 씀'),
            h('td', {}, s.source === 'env' ? h('span', { class: 'ok' }, '환경변수') : s.source === 'saved' ? h('span', { class: 'ok' }, '이 PC에 저장됨') : h('span', { class: 'bad' }, '없음 (이 값을 쓰는 TC는 Blocked)')),
            h('td', { style: 'white-space:nowrap' }, h('div', { class: 'row' }, v, h('button', { class: 'btn small', type: 'button', onclick: () => v.value && saveOne(s.name, v.value) }, '저장'),
              s.source === 'saved' ? confirmButton('삭제', async () => { const out = await guard(() => api('DELETE', `/api/secrets/${encodeURIComponent(s.name)}`)); if (out) { toast(`${s.name} 삭제했습니다`); draw(out); } }, 'btn small danger') : null)));
        })))) : h('div', { class: 'sub' }, '아직 비밀값이 없습니다'),
      h('div', { class: 'row' }, name, value, h('button', { class: 'btn', type: 'button', onclick: () => saveOne(name.value.trim(), value.value) }, '추가')));
  };
  draw(list);
  return h('section', { class: 'card stack' },
    h('h3', {}, '비밀값'),
    h('div', { class: 'sub' }, '계정 비밀번호·토큰은 data/testdata.json에 {"secret": "이름"}으로만 적고, 값은 여기(data/state/secrets.json, Git 제외) 또는 같은 이름의 환경변수로 넣습니다. CI에서는 GitHub 저장소 Secrets에 같은 이름으로 넣으세요. 생성된 스크립트·리포트에는 값이 남지 않습니다.'),
    body);
}

// ---------- 품질 지표 ----------
async function renderMetrics() {
  app().replaceChildren(h('section', { class: 'card' }, h('h2', {}, '품질 지표'), h('div', { class: 'sub' }, '계산 중…')));
  const m = await guard(() => api('GET', '/api/metrics'));
  if (!m) return;
  const kpi = (t, n, cls, sub) => h('div', { class: 'kpi' }, h('div', { class: `n ${cls || ''}` }, n), h('div', { class: 't' }, t), sub ? h('div', { class: 'sub', style: 'font-size:11.5px' }, sub) : null);
  const roi = m.roi;
  const head = h('section', { class: 'card stack' },
    h('div', {}, h('h2', {}, '품질 지표'), h('div', { class: 'sub' }, `최근 실행 ${roi.runs}회 · 실행 결과 ${roi.executed}건 기준`)),
    h('div', { class: 'kpis' },
      kpi('ROI (절감 ÷ 투자)', roi.ratio === null ? '-' : `${roi.ratio}배`, roi.ratio >= 1 ? 'ok' : 'warn', roi.ratio >= 1 ? '투자 회수함' : roi.runsToBreakEven === null ? '' : `지금 속도로 ${roi.runsToBreakEven}회 더 실행하면 회수`),
      kpi('절감 시간', `${roi.savedHours}h`, '', `실행 1회당 ${roi.savedHoursPerRun}h`),
      kpi('자동화 비율', pct(m.coverage.automatedRate), '', `${m.coverage.automated}/${m.coverage.tcs} TC`),
      kpi('요구사항 커버리지', pct(m.coverage.reqRate), '', `${m.coverage.reqsAutomated}/${m.coverage.reqs} 요구사항`),
      kpi('실패 대 결함', m.quality.failuresToDefects === null ? '-' : `${m.quality.failuresToDefects} : 1`, '', `Fail ${m.quality.failures}건 · BUG ${m.quality.bugs}건`)));

  const maxMs = Math.max(1, ...m.trend.map((t) => t.durationMs));
  const trendCard = h('section', { class: 'card stack' },
    h('h3', {}, '실행 추세'),
    m.trend.length ? h('div', {},
      h('div', { class: 'sub' }, '막대 높이 = 통과율, 빨강 = 종료 기준 미충족. 막대를 누르면 그 실행으로 갑니다'),
      h('div', { class: 'trend', role: 'img', 'aria-label': `최근 ${m.trend.length}회 통과율` }, m.trend.map((t) => h('a', {
        class: `col${t.releasable ? '' : ' no'}`, href: '#dash', title: `${t.id} ${t.label} · 통과율 ${pct(t.passRate)} · ${fmtDur(t.durationMs)}`,
        onclick: () => { S.dashRunId = t.id; },
      }, h('i', { style: `height:${Math.max(2, (t.passRate || 0) * 100)}%` })))),
      h('div', { class: 'sub', style: 'margin-top:6px' }, `최근 5회 평균 실행 시간 ${m.quality.avgRunMs ? fmtDur(m.quality.avgRunMs) : '-'} · 가장 긴 실행 ${fmtDur(maxMs)} · Flaky 비율 ${pct(m.quality.flakyRate)}`))
      : h('div', { class: 'empty' }, '실행 기록이 없습니다'));

  const stab = h('section', { class: 'card stack' },
    h('h3', {}, 'TC별 판정 이력 (테스트 히스토그램)'),
    h('div', { class: 'sub' }, '최근 20회. 초록 Pass · 빨강 Fail · 주황 Flaky. 불안정한 순서로 정렬했습니다. 자주 흔들리는 TC는 대기·식별자·데이터를 먼저 고치세요 (ISTQB CTAL-TAE 8.1.1)'),
    m.stability.length ? h('div', { class: 'tbl' }, h('table', {},
      h('thead', {}, h('tr', {}, ['TC', '실행 단위', '최근 판정', 'Fail', 'Flaky', '불안정'].map((t) => h('th', {}, t)))),
      h('tbody', {}, m.stability.slice(0, 40).map((s) => h('tr', {},
        h('td', {}, h('a', { class: 'mono', href: `#tcs/${encodeURIComponent(s.tcId)}` }, s.tcId), h('div', { class: 'sub' }, s.title)),
        h('td', { class: 'mono' }, s.project),
        h('td', {}, h('span', { class: 'hist', 'aria-label': s.recent.join(', ') }, s.recent.map((x) => h('i', { class: x, title: x })))),
        h('td', { class: 'num' }, s.fail), h('td', { class: 'num' }, s.flaky),
        h('td', { class: 'num' }, pct(s.unstable)))))))
      : h('div', { class: 'empty' }, '이력이 없습니다'));

  const inv = roi.investment;
  const roiCard = h('section', { class: 'card stack' },
    h('h3', {}, 'ROI 계산 (ISTQB CT-TAS 5.1)'),
    h('div', { class: 'formula' }, `ROI = 절감 ÷ 투자 = ${roi.savedHours}h ÷ ${roi.investedHours}h = ${roi.ratio === null ? '-' : roi.ratio}

절감 = Σ (TC 수동 실행 시간 − 자동 실행 시간)          = ${roi.savedHours}h
투자 = 구축 ${inv.setup}h + TC 작성 ${inv.authoring}h + 스크립트 수정 ${inv.maintenance}h + 실패 분석 ${inv.analysis}h = ${roi.investedHours}h`),
    roi.manualMissing ? h('div', { class: 'sub warn' }, `수동 실행 시간이 없는 자동화 TC ${roi.manualMissing}건은 기본값 ${roi.config.manualMinutesDefault}분으로 계산했습니다. TC 편집에서 실제 시간을 넣으세요`) : null,
    h('div', { class: 'sub' }, '계산 기준은 설정 → ROI 계산 기준에서 바꿉니다. 프로젝트 기간이 회수 시점보다 짧으면 자동화하지 않는 편이 낫습니다.'));

  const d = m.distribution;
  const total = d.layers.ui + d.layers.api || 1;
  const shapeName = { umbrella: '우산형 (UI 테스트에만 의존)', cone: '아이스크림콘형 (UI가 API보다 많음)', pyramid: '피라미드형에 가까움 (API가 UI 이상)' }[d.shape] || '-';
  const distCard = h('section', { class: 'card stack' },
    h('h3', {}, '테스트 분포 (ISTQB CT-TAS 3.1)'),
    h('div', { class: 'shape', 'aria-label': `UI ${d.layers.ui}건, API ${d.layers.api}건` },
      h('b', { class: 'ui', style: `width:${Math.max(18, (d.layers.ui / total) * 100)}%` }, `UI ${d.layers.ui}`),
      h('b', { class: 'api', style: `width:${Math.max(18, (d.layers.api / total) * 100)}%` }, `API ${d.layers.api}`),
      h('b', { class: 'unit', style: 'width:100%' }, '단위 테스트 (개발 저장소)')),
    h('div', {}, `지금 모양: ${shapeName}`),
    h('div', { class: 'sub' }, 'UI 테스트는 느리고 깨지기 쉬워 위로 갈수록 적게 두는 것이 목표입니다. 화면 사전 조건(계정·데이터 준비)을 API 스텝으로 옮기면 UI TC가 짧고 안정적이 됩니다.'),
    Object.keys(d.assertKinds).length ? h('div', { class: 'sub' }, `확인 스텝 종류: ${Object.entries(d.assertKinds).map(([k, n]) => `${S.meta.actions[k] ? S.meta.actions[k].label : k} ${n}`).join(' · ')}`) : null);

  const cov = m.coverage;
  const covCard = h('section', { class: 'card stack' },
    h('h3', {}, '커버리지'),
    h('div', {}, `플랫폼별 자동화 TC: ${Object.entries(cov.platforms).map(([p, n]) => `${PL(p)} ${n}`).join(' · ') || '-'}`),
    cov.reqsManualOnly.length ? h('div', { class: 'sub warn' }, `자동화 TC가 없는 요구사항 ${cov.reqsManualOnly.length}개: ${cov.reqsManualOnly.join(', ')}`) : h('div', { class: 'sub' }, '모든 요구사항에 자동화 TC가 있습니다'),
    cov.withoutReq.length ? h('div', { class: 'sub' }, `요구사항 ID가 없는 자동화 TC ${cov.withoutReq.length}건: ${cov.withoutReq.join(', ')} (추적성을 위해 넣는 것을 권장)`) : null);

  app().replaceChildren(head, h('div', { class: 'grid2' }, trendCard, roiCard), stab, h('div', { class: 'grid2' }, distCard, covCard));
}

// ---------- 요소 맵 ----------
async function renderElements() {
  S.elements = await api('GET', '/api/elements');
  const data = JSON.parse(JSON.stringify(S.elements));
  const used = {};
  S.tcs.forEach((t) => t.steps.forEach((s) => { if (s.target) used[s.target] = (used[s.target] || 0) + 1; }));
  Object.values(S.flows).forEach((f) => f.steps.forEach((s) => { if (s.target) used[s.target] = (used[s.target] || 0) + 1; }));
  let dirty = false;
  const mark = () => { dirty = true; saveBtn.disabled = false; };
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: async () => {
    const saved = await guard(() => api('PUT', '/api/elements', data));
    if (saved) { S.elements = saved; dirty = false; toast('요소 맵을 저장했습니다'); renderElements(); }
  } }, '저장');

  const WEB_TYPES = { testId: 'testId', css: 'CSS', role: 'role', text: '텍스트' };
  const webType = (w) => (w ? Object.keys(WEB_TYPES).find((k) => w[k]) || 'testId' : 'testId');
  const elRows = h('tbody');
  const drawEls = () => {
    elRows.replaceChildren(...Object.entries(data.elements).map(([name, e]) => {
      const t = webType(e.web);
      const mobile = (p) => h('input', { type: 'text', 'aria-label': `${name} ${PL(p)} 식별자`, value: e[p] && e[p].id ? e[p].id : '', placeholder: '미부여', oninput: (ev) => { e[p] = ev.target.value.trim() ? { id: ev.target.value.trim() } : null; mark(); } });
      return h('tr', {},
        h('td', { class: 'mono' }, name),
        h('td', {}, h('input', { type: 'text', 'aria-label': `${name} 이름`, value: e.label, oninput: (ev) => { e.label = ev.target.value; mark(); } })),
        h('td', {}, h('select', { 'aria-label': `${name} 웹 식별 방식`, onchange: (ev) => { const v = e.web ? e.web[t] : ''; e.web = { [ev.target.value]: v }; mark(); drawEls(); } }, Object.entries(WEB_TYPES).map(([k, l]) => h('option', { value: k, selected: k === t }, l)))),
        h('td', {}, h('input', { type: 'text', 'aria-label': `${name} 웹 식별자`, value: e.web ? e.web[t] || '' : '', oninput: (ev) => { e.web = { ...(e.web || {}), [t]: ev.target.value }; mark(); } }),
          t === 'role' ? h('input', { type: 'text', 'aria-label': `${name} role 이름`, placeholder: '접근 이름 (예: 로그인)', value: e.web.name || '', style: 'margin-top:4px', oninput: (ev) => { e.web.name = ev.target.value; mark(); } }) : null),
        h('td', {}, mobile('android')),
        h('td', {}, mobile('ios')),
        h('td', { class: 'num' }, used[name] || 0),
        h('td', {}, h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${name} 삭제`, title: used[name] ? 'TC에서 쓰는 요소라 지울 수 없습니다' : '삭제', disabled: !!used[name], onclick: () => { delete data.elements[name]; mark(); drawEls(); } }, '✕')));
    }));
  };
  drawEls();

  const newName = h('input', { type: 'text', placeholder: '새 요소 이름 (예: login.findPw)', 'aria-label': '새 요소 이름' });
  const addEl = h('button', { class: 'btn', type: 'button', onclick: () => {
    const n = newName.value.trim();
    if (!/^[a-zA-Z]\w*(\.\w+)+$/.test(n)) { toast('요소 이름은 화면.요소 형식으로 쓰세요 (예: login.findPw)', true); return; }
    if (data.elements[n]) { toast('이미 있는 이름입니다', true); return; }
    data.elements[n] = { label: n, web: { testId: '' }, android: null, ios: null };
    newName.value = ''; mark(); drawEls();
  } }, '요소 추가');

  const scRows = h('tbody', {}, Object.entries(data.screens).map(([name, s]) => h('tr', {},
    h('td', { class: 'mono' }, name),
    h('td', {}, h('input', { type: 'text', 'aria-label': `${name} 이름`, value: s.label, oninput: (ev) => { s.label = ev.target.value; mark(); } })),
    h('td', {}, h('input', { type: 'text', 'aria-label': `${name} 웹 경로`, value: s.web || '', oninput: (ev) => { s.web = ev.target.value; mark(); } })),
    h('td', {}, h('input', { type: 'text', 'aria-label': `${name} 안드로이드 딥링크`, value: s.android || '', placeholder: '첫 화면이면 비워도 됨', oninput: (ev) => { if (ev.target.value.trim()) s.android = ev.target.value.trim(); else delete s.android; mark(); } })),
    h('td', { class: 'num' }, used[name] || 0))));

  const missing = (p) => Object.entries(data.elements).filter(([, e]) => !e[p]).map(([n, e]) => `${n} (${e.label})`);
  const requestText = () => ['[테스트 자동화용 식별자 부여 요청]', '', '안드로이드 resource-id 미부여:', ...missing('android').map((x) => `- ${x}`), '', '아이폰 accessibilityIdentifier 미부여:', ...missing('ios').map((x) => `- ${x}`)].join('\n');

  app().replaceChildren(
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('div', {}, h('h2', {}, '요소 맵'), h('div', { class: 'sub' }, 'TC는 논리 이름(login.submit)으로 요소를 부르고, 실제 식별자는 여기서 플랫폼별로 관리합니다. UI가 바뀌면 이 표만 고칩니다.')), saveBtn),
      h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['논리 이름', '이름', '웹 방식', '웹 식별자 (PC · MW)', '안드로이드 id', '아이폰 id', '사용', ''].map((t) => h('th', {}, t)))), elRows)),
      h('div', { class: 'row' }, newName, addEl)),
    h('div', { class: 'grid2' },
      h('section', { class: 'card stack' }, h('h3', {}, '화면'), h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['논리 이름', '이름', '웹 경로', '안드로이드 딥링크', '사용'].map((t) => h('th', {}, t)))), scRows))),
      h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', {}, '개발팀 요청 목록'), h('button', { class: 'btn small', type: 'button', onclick: () => copyText(requestText()) }, '요청문 복사')),
        h('div', { class: 'sub' }, `안드로이드 미부여 ${missing('android').length}개 · 아이폰 미부여 ${missing('ios').length}개`),
        h('pre', { style: 'max-height:240px' }, requestText()))));
  window.onbeforeunload = () => (dirty ? true : undefined);
}

// ---------- 기기 관리 ----------
const GUIDES = {
  api: ['API 주소는 설정 → 대상 사이트의 API 주소 (비우면 대상 사이트 주소)', 'API TC는 브라우저 없이 실행되어 UI 테스트보다 빠르고 안정적입니다', '응답 형식(스키마)은 data/schemas/<이름>.json에 JSON Schema로 둡니다'],
  pc: ['Chromium이 없으면 터미널에서 npx playwright install chromium 실행', '테스트 URL은 data/config.json의 baseURL'],
  mw: ['기기 프리셋은 data/config.json의 mw.devices (예: "Pixel 7", "iPhone 13")', 'iPhone 프리셋은 WebKit이 필요: npx playwright install webkit', '에뮬레이션은 실제 사파리·인앱 브라우저가 아니므로 핵심 TC는 실기기로 재확인'],
  android: [
    'Android SDK Platform-Tools 설치 후 adb를 PATH에 추가',
    'Java 17 이상 설치 후 Maestro 설치 (maestro.mobile.dev, Windows는 zip을 풀고 bin 폴더를 PATH에 추가)',
    '폰: 설정 → 휴대전화 정보 → 빌드번호 7번 탭 → 개발자 옵션 → USB 디버깅 켜기',
    'USB 연결 후 폰에 뜨는 "USB 디버깅 허용" 승인, 테스트 중 화면 자동 꺼짐 끄기',
    'data/config.json의 android.appId에 앱 패키지명 입력. APK 경로(android.apkPath)를 넣으면 실행 전에 자동 설치',
    '요소 맵의 안드로이드 id 칸에 resource-id 입력. 비어 있는 요소를 쓰는 TC는 Blocked 처리',
  ],
  ios: ['아이폰 실행은 Mac(Xcode)이 필요합니다', 'Mac에 에이전트를 띄우고 data/config.json의 ios.agentUrl에 주소 입력', 'Mac이 없으면 클라우드 디바이스 팜 연동을 검토'],
};

async function renderDevices() {
  app().replaceChildren(h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h2', {}, '기기와 실행 환경'), h('span', { class: 'sub' }, '점검 중…'))));
  S.devices = await guard(() => api('GET', '/api/devices'));
  if (!S.devices) return;
  app().replaceChildren(
    h('section', { class: 'card' }, h('div', { class: 'row between' }, h('div', {}, h('h2', {}, '기기와 실행 환경'), h('div', { class: 'sub' }, '실행할 때마다 같은 점검을 다시 합니다. 실패 항목이 있는 플랫폼의 TC는 Blocked로 남습니다.')),
      h('button', { class: 'btn', type: 'button', onclick: renderDevices }, '다시 점검'))),
    h('div', { class: 'devcards' }, S.devices.map((d) => h('section', { class: 'card' },
      h('div', { class: 'row between' }, plat(d.platform), h('span', { class: `pill ${d.ok ? 's-Pass' : 's-Blocked'}` }, d.ok ? '준비됨' : 'Blocked')),
      h('ul', { class: 'checks', style: 'margin-top:10px' }, d.items.map((i) => h('li', {}, h('span', { class: i.ok ? 'ok' : 'bad' }, i.ok ? '✓' : '✕'), h('span', { class: 'lbl' }, i.label), h('span', {}, i.detail)))),
      h('div', { class: 'guide' }, '준비 방법', h('ol', {}, GUIDES[d.platform].map((g) => h('li', {}, g))))))));
}

// ---------- 이슈 관리 ----------
async function renderIssues() {
  S.issues = await api('GET', '/api/issues');
  const types = ['ALL', 'BUG', 'AUT', 'ENV', 'FLK'];
  const typeLabel = { ALL: '전체', BUG: '제품 결함', AUT: '스크립트', ENV: '환경', FLK: 'Flaky' };
  const count = (t) => S.issues.filter((i) => (t === 'ALL' || i.type === t) && (!S.hideClosed || i.status !== '종료')).length;
  const rows = S.issues.filter((i) => (S.issueType === 'ALL' || i.type === S.issueType) && (!S.hideClosed || i.status !== '종료'))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  const update = async (issue, patch) => {
    const saved = await guard(() => api('PUT', `/api/issues/${issue.id}`, patch));
    if (saved) { Object.assign(issue, saved); toast(`${issue.id} 저장했습니다`); renderIssues(); }
  };

  const table = rows.length ? h('div', { class: 'tbl' }, h('table', {},
    h('thead', {}, h('tr', {}, ['ID', '유형', '심각도', '내용', '플랫폼', '발생', '최근', '상태', '이슈 트래커', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((i) => h('tr', {},
      h('td', { class: 'mono' }, i.id),
      h('td', {}, typePill(i.type)),
      h('td', {}, i.type === 'BUG' ? h('select', { 'aria-label': `${i.id} 심각도`, onchange: (e) => update(i, { severity: e.target.value }) }, S.meta.severities.map((s) => h('option', { value: s, selected: s === i.severity }, s))) : h('span', { class: 'sub' }, '-')),
      h('td', {}, h('div', {}, i.title), h('div', { class: 'sub mono' }, `${i.tcId}${i.stepTitle ? ` · ${i.stepTitle}` : ''}`)),
      h('td', {}, plat(i.platform)),
      h('td', { class: 'num' }, i.count),
      h('td', {}, fmtTime(i.lastSeen)),
      h('td', {}, h('select', { 'aria-label': `${i.id} 상태`, onchange: (e) => update(i, { status: e.target.value }) }, (i.type === 'BUG' ? S.meta.statuses.BUG : S.meta.statuses.OTHER).map((s) => h('option', { value: s, selected: s === i.status }, s)))),
      h('td', {}, h('input', { type: 'text', 'aria-label': `${i.id} 이슈 트래커 ID`, value: i.trackerId, placeholder: 'JIRA-123', style: 'width:110px', onchange: (e) => update(i, { trackerId: e.target.value }) })),
      h('td', { style: 'white-space:nowrap' },
        i.status === '수정 완료' ? h('button', { class: 'btn small primary', type: 'button', onclick: () => startRun({ tcIds: [i.tcId], platforms: [i.platform], label: `재검증 ${i.id}` }) }, '재검증 실행') : null,
        i.draft ? h('button', { class: 'btn small', type: 'button', onclick: () => copyText(i.draft) }, '초안 복사') : null,
        h('a', { class: 'btn small', href: `#result/${i.lastRunId}/${encodeURIComponent(i.resultKey)}` }, '결과')))))))
    : h('div', { class: 'empty' }, S.issues.length ? '조건에 맞는 이슈가 없습니다' : '아직 이슈가 없습니다. 실행에서 Fail·Flaky가 나오면 여기에 자동으로 쌓입니다.');

  app().replaceChildren(h('section', { class: 'card stack' },
    h('div', {}, h('h2', {}, '이슈 관리'), h('div', { class: 'sub' }, '같은 실패 시그니처(플랫폼 · TC · 스텝 · 오류 유형 · 대상)는 하나의 이슈로 묶고 발생 횟수만 올립니다. 수정 완료로 바꾼 뒤 재검증이 Pass면 자동으로 종료됩니다.')),
    h('div', { class: 'row between' },
      h('div', { class: 'chips' }, types.map((t) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.issueType === t), onclick: () => { S.issueType = t; renderIssues(); } }, `${typeLabel[t]} ${count(t)}`))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.hideClosed, onchange: (e) => { S.hideClosed = e.target.checked; renderIssues(); } }), '종료 숨기기')),
    table));
}

// ---------- 시작 ----------
loadAll().then(route).catch((e) => {
  app().replaceChildren(h('div', { class: 'errbox' }, `콘솔을 불러오지 못했습니다: ${e.message}\nAutoTC 창이 켜져 있는지 확인하세요.`));
});
