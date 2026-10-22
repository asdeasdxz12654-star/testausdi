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
    const active = a.dataset.view === v || (v === 'result' && a.dataset.view === 'dash') || (v === 'import' && a.dataset.view === 'tcs');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (v !== 'mapping') { clearInterval(S.mapPoll); S.mapPoll = null; }
  const views = { dash: renderDash, tcs: () => renderTcs(rest[0]), import: renderImport, mapping: () => renderMapping(rest[0]), elements: renderElements, devices: renderDevices, issues: renderIssues, result: () => renderResult(rest[0], rest[1]) };
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
  const side = h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, `TC ${S.tcs.length}건`),
    h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#import' }, 'TC 가져오기'), h('a', { class: 'btn small', href: '#tcs/new' }, '새 TC'))), search, list);
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
    d.source ? h('details', { class: 'notice', open: d.automation === '수동 유지' },
      h('summary', {}, `${d.source.url ? '스프레드시트' : '엑셀'} 원문 · ${d.source.file} ${d.source.sheet} ${d.source.row}행${d.source.originalId ? ` · 원래 ID ${d.source.originalId}` : ''}`),
      d.source.url ? h('div', { style: 'margin-top:6px' }, h('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, '원본 시트 열기')) : null,
      h('div', { class: 'grid2', style: 'margin-top:8px' },
        h('div', {}, h('div', { class: 'sub' }, '테스트 절차'), h('pre', { style: 'white-space:pre-wrap' }, d.source.steps || '-')),
        h('div', {}, h('div', { class: 'sub' }, '기대결과'), h('pre', { style: 'white-space:pre-wrap' }, d.source.expected || '-'))),
      h('div', { class: 'sub', style: 'margin-top:6px' }, '원문을 보고 아래 스텝을 채운 뒤 자동화를 "적합"으로 바꾸면 실행 대상이 됩니다')) : null,
    h('div', { class: 'row between' }, h('h3', {}, `스텝 ${d.steps.length}개`), h('span', { class: 'sub' }, '점은 플랫폼 지원 여부 (PC · MW · 안드로이드 · 아이폰)')),
    h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', '액션', '대상', '값', '지원', ''].map((t) => h('th', {}, t)))), stepsBody)),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { d.steps.push({ action: 'tap', target: Object.keys(S.elements.elements)[0] }); mark(); drawSteps(); } }, '스텝 추가'),
      h('span', { class: 'sub' }, '값에 {{account.id}}처럼 쓰면 data/testdata.json 값으로 바뀌고, 리포트에는 실제 값 대신 이름만 남습니다')),
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
    h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: save }, '설정 저장')));
}

async function renderMapping(pid) {
  if (!pid) return renderMappingList();
  const v = await guard(() => api('GET', `/api/mapping/${pid}`));
  if (!v) { location.hash = '#mapping'; return; }
  S.map = S.map && S.map.id === pid ? Object.assign(S.map, { v }) : { id: pid, v, sel: null, showGaps: false };
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
    h('span', { class: 'mono sub' }, t.id), t.title,
    t.automation === '수동 유지' ? h('span', { class: 'sub' }, ' · 수동 유지') : null,
    v.results[t.id] ? h('span', { class: 'sub' }, ' · 분석됨') : null)));
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
  const runCard = h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h3', {}, '분석'),
      busy ? h('span', { class: 'sub' }, `${v.phase || '분석 중'} · ${v.progress ? `${v.progress.done}/${v.progress.total}` : ''}`) : null),
    busy && v.progress ? h('div', { class: 'bar' }, h('i', { class: 'Pass', style: `width:${(v.progress.done / Math.max(1, v.progress.total)) * 100}%` })) : null,
    !busy ? h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', disabled: !est.calls, onclick: () => start(true) }, est.calls ? `새 TC 분석 (호출 ${est.calls}회, 약 $${est.usd})` : '새로 분석할 TC 없음'),
      Object.keys(v.results).length ? h('button', { class: 'btn', type: 'button', onclick: () => start(false) }, `전체 다시 분석 (호출 ${v.estimateAll.calls}회, 약 $${v.estimateAll.usd})`) : null,
      h('a', { class: 'btn small', href: '#mapping' }, '설정')) : null,
    h('div', { class: 'sub' }, '비용은 Claude Opus 5.5 기준 대략값입니다. 기획서·디자인은 첫 호출 뒤 캐시되어 TC가 늘어도 자료 비용은 크게 늘지 않습니다.'),
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
      h('div', {}, h('div', { class: 'mono sub' }, r.tcId), h('b', {}, r.title)),
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
