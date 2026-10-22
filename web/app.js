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
  const [meta, config, tcs, elements, flows, runs, issues] = await Promise.all([
    api('GET', '/api/meta'), api('GET', '/api/config'), api('GET', '/api/tcs'), api('GET', '/api/elements'),
    api('GET', '/api/flows'), api('GET', '/api/runs'), api('GET', '/api/issues'),
  ]);
  Object.assign(S, { meta, config, tcs, elements, flows, runs, issues });
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
    const active = a.dataset.view === v || (v === 'result' && a.dataset.view === 'dash');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const views = { dash: renderDash, tcs: () => renderTcs(rest[0]), elements: renderElements, devices: renderDevices, issues: renderIssues, result: () => renderResult(rest[0], rest[1]) };
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
    S.meta.platforms.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'platform', value: p, checked: p === 'pc' || p === 'mw' }), plat(p))));
  const suite = h('select', { name: 'suite', id: 'suiteSel' }, h('option', { value: '' }, `전체 자동화 TC (${S.tcs.filter((t) => t.automation !== '수동 유지').length}건)`),
    tags.map((t) => h('option', { value: t }, `@${t} (${S.tcs.filter((x) => (x.tags || []).includes(t)).length}건)`)));
  form.append(h('div', { class: 'row between' }, h('h2', {}, '새 실행'), h('span', { class: 'sub' }, `대상 ${S.config.baseURL}`)),
    platRow,
    h('div', { class: 'row' }, h('span', { class: 'sub' }, '스위트'), suite, h('button', { class: 'btn primary', type: 'submit', disabled }, disabled ? '실행 중…' : '실행')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const platforms = [...form.querySelectorAll('input[name=platform]:checked')].map((i) => i.value);
    const tag = form.querySelector('select[name=suite]').value;
    startRun({ platforms, tags: tag ? [tag] : undefined });
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
    sm.quarantined ? h('div', { class: 'sub' }, `격리된 Flaky TC ${sm.quarantined}건은 집계에서 뺐습니다`) : null);

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
        h('td', {}, r.failedStep ? r.failedStep.title : (r.reason || '-')),
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
  const shot = r.attachments.find((a) => a.contentType === 'image/png');
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
    r.reason ? h('div', { class: r.status === 'Blocked' ? 'errbox' : 'notice' }, r.reason) : null);

  const left = h('div', { class: 'stack' });
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
  const side = h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, `TC ${S.tcs.length}건`), h('a', { class: 'btn small', href: '#tcs/new' }, '새 TC')), search, list);
  app().replaceChildren(h('div', { class: 'split' }, side, S.draft ? tcEditor() : h('div', { class: 'empty' }, 'TC가 없습니다. 새 TC를 만들어 보세요.')));
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
    field('요구사항 ID (쉼표로 구분)', list('reqIds'), 'wide'),
    field('사전조건', h('textarea', { id: 'f-pre', rows: '2', oninput: (e) => { d.precondition = e.target.value; mark(); } }, d.precondition), 'wide'),
    h('div', { class: 'wide row' }, h('span', { class: 'sub' }, '플랫폼'), S.meta.platforms.map((p) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: d.platforms.includes(p), onchange: (e) => { d.platforms = e.target.checked ? [...new Set([...d.platforms, p])] : d.platforms.filter((x) => x !== p); mark(); } }), plat(p)))));

  const stepsBody = h('tbody');
  const drawSteps = () => {
    stepsBody.replaceChildren(...d.steps.map((s, i) => {
      const def = S.meta.actions[s.action];
      const targets = def.target === 'screen' ? S.elements.screens : def.target === 'element' ? S.elements.elements : def.target === 'flow' ? S.flows : null;
      const support = S.meta.platforms.map((p) => {
        const m = def.support[p];
        return h('i', { class: `${p}${m === 'run' ? ' on' : ''}`, title: `${PL(p)}: ${m === 'run' ? '실행' : m === 'noop' ? '건너뜀' : '지원 안 함'}` });
      });
      return h('tr', {},
        h('td', { class: 'num' }, i + 1),
        h('td', {}, h('select', { 'aria-label': `${i + 1}번 스텝 액션`, onchange: (e) => {
          s.action = e.target.value;
          const nd = S.meta.actions[s.action];
          const pool = nd.target === 'screen' ? S.elements.screens : nd.target === 'element' ? S.elements.elements : nd.target === 'flow' ? S.flows : null;
          if (!pool) delete s.target; else if (!pool[s.target]) s.target = Object.keys(pool)[0];
          if (!nd.value) delete s.value; else if (s.value === undefined) s.value = '';
          mark(); drawSteps();
        } }, Object.entries(S.meta.actions).map(([k, a]) => h('option', { value: k, selected: k === s.action }, `${a.label} (${k})`)))),
        h('td', {}, targets ? h('select', { 'aria-label': `${i + 1}번 스텝 대상`, onchange: (e) => { s.target = e.target.value; mark(); } },
          Object.entries(targets).map(([k, t]) => h('option', { value: k, selected: k === s.target }, `${t.label} · ${k}`))) : h('span', { class: 'sub' }, '-')),
        h('td', {}, def.value ? h('input', { type: 'text', 'aria-label': `${i + 1}번 스텝 값`, value: s.value || '', placeholder: '값 또는 {{account.id}}', oninput: (e) => { s.value = e.target.value; mark(); } }) : h('span', { class: 'sub' }, '-')),
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
    h('div', { class: 'row between' }, h('h3', {}, `스텝 ${d.steps.length}개`), h('span', { class: 'sub' }, '점은 플랫폼 지원 여부 (PC · MW · 안드로이드 · 아이폰)')),
    h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', '액션', '대상', '값', '지원', ''].map((t) => h('th', {}, t)))), stepsBody)),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { d.steps.push({ action: 'tap', target: Object.keys(S.elements.elements)[0] }); mark(); drawSteps(); } }, '스텝 추가'),
      h('span', { class: 'sub' }, '값에 {{account.id}}처럼 쓰면 data/testdata.json 값으로 바뀌고, 리포트에는 실제 값 대신 이름만 남습니다')),
    h('div', { class: 'row between' }, h('h3', {}, '엔진별 코드'), h('button', { class: 'btn small', type: 'button', onclick: loadPreview }, '코드 보기')),
    previewBox);
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
