/* RT Task Log — standalone app (Supabase backend). */
(() => {
  'use strict';

  const LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  const ICON = { todo: '', in_progress: '◐', blocked: '!', done: '✓' };
  const ORDER = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
  const PRIO = { high: 0, normal: 1, low: 2 };
  const NEXT = { todo: 'in_progress', in_progress: 'done', blocked: 'in_progress', done: 'todo' };
  const DEFAULT_CATS = ['Teaching', 'Operations', 'Admin', 'Partnerships', 'Makerspace', 'Events', 'Curriculum', 'Personal'];
  const PAGE = 1000;           // Supabase returns at most 1000 rows per request
  const REFRESH_MS = 60000;    // re-sync while the page is visible

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const fmtLong = s => parse(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = s => parse(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const fmtWd = s => parse(s).toLocaleDateString(undefined, { weekday: 'short' });
  const isoDay = iso => iso ? ymd(new Date(iso)) : '';
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  const state = { tasks: [], selected: today(), view: 'day', filter: 'all', loaded: false, editId: null, lastSync: null, syncError: false };
  let sb = null;
  let pending = 0;             // writes in flight; skip background refresh while > 0
  const queues = {};

  /* ---------- row <-> app model ---------- */
  function fromRow(r) {
    return {
      id: r.id, title: r.title, notes: r.notes || '', date: r.log_date, due: r.due_date || '',
      priority: PRIO[r.priority] !== undefined ? r.priority : 'normal', category: r.category || '',
      status: LABEL[r.status] ? r.status : 'todo', progress: r.progress || 0, prevProgress: r.prev_progress || 0,
      completedAt: r.completed_at || '', createdAt: r.created_at || '', updatedAt: r.updated_at || ''
    };
  }
  const FIELD = { title: 'title', notes: 'notes', date: 'log_date', due: 'due_date', priority: 'priority', category: 'category',
    status: 'status', progress: 'progress', prevProgress: 'prev_progress', completedAt: 'completed_at' };
  function toRow(patch) {
    const row = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in FIELD)) continue;
      row[FIELD[k]] = (k === 'due' || k === 'completedAt') ? (v || null) : v;
    }
    return row;
  }

  /* ---------- server I/O ---------- */
  async function loadAll() {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('tasks').select('*').order('created_at', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    return rows.map(fromRow);
  }
  async function refresh(quiet) {
    if (pending > 0) return;
    try {
      const tasks = await loadAll();
      if (pending > 0) return;           // a write started meanwhile; next refresh picks it up
      state.tasks = tasks; state.loaded = true; state.syncError = false; state.lastSync = new Date();
      if (state.editId && !tasks.some(t => t.id === state.editId)) closeSheet();
      render();
    } catch (e) {
      state.syncError = true; renderSync();
      if (!quiet) toast(isAuthError(e) ? 'Your session expired. Please sign in again.' : 'Could not load your tasks. Check your connection.');
      if (isAuthError(e)) await sb.auth.signOut();
    }
  }
  const isAuthError = e => e && (e.status === 401 || /JWT|jwt|token/.test(e.message || ''));

  function enqueue(id, fn) {
    pending++;
    queues[id] = (queues[id] || Promise.resolve())
      .then(fn)
      .then(({ error } = {}) => { if (error) throw error; state.syncError = false; state.lastSync = new Date(); renderSync(); })
      .catch(e => {
        state.syncError = true;
        toast(navigator.onLine === false ? 'You are offline. That change was not saved.' : 'That change did not save. Your list has been reloaded.');
        console.error('[tasklog] write failed', e);
      })
      .finally(() => { pending--; if (pending === 0 && state.syncError) refresh(true); });
    return queues[id];
  }

  function createTask(fields) {
    const now = new Date().toISOString();
    const t = { id: uuid(), title: fields.title, notes: '', date: fields.date, due: '', priority: fields.priority || 'normal',
      category: fields.category || '', status: 'todo', progress: 0, prevProgress: 0, completedAt: '', createdAt: now, updatedAt: now };
    state.tasks.push(t);
    render();
    enqueue(t.id, () => sb.from('tasks').insert({ id: t.id, ...toRow(t) }));
  }
  function patchTask(id, patch) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    render();
    enqueue(id, () => sb.from('tasks').update(toRow(patch)).eq('id', id));
  }
  function deleteTask(id) {
    state.tasks = state.tasks.filter(x => x.id !== id);
    render();
    enqueue(id, () => sb.from('tasks').delete().eq('id', id));
  }

  /* ---------- business rules: status <-> progress (mirrored by a DB constraint) ---------- */
  function statusPatch(t, status) {
    const p = { status };
    if (status === 'done') { p.progress = 100; p.completedAt = new Date().toISOString(); if (t.status !== 'done') p.prevProgress = t.progress; }
    else {
      p.completedAt = '';
      if (t.status === 'done') p.progress = status === 'todo' ? 0 : (t.prevProgress > 0 && t.prevProgress < 100 ? t.prevProgress : 50);
      else if (status === 'in_progress' && !t.progress) p.progress = 10;
    }
    return p;
  }
  function progressPatch(t, v) {
    if (v >= 100) return statusPatch(t, 'done');
    const p = { progress: v };
    if (t.status === 'done') { p.status = 'in_progress'; p.completedAt = ''; }
    else if (t.status === 'todo' && v > 0) p.status = 'in_progress';
    return p;
  }

  /* ---------- views ---------- */
  const dueKey = t => t.due || '9999-12-31';
  const sortTasks = arr => arr.slice().sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (PRIO[a.priority] - PRIO[b.priority])
    || dueKey(a).localeCompare(dueKey(b)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const matches = t => state.filter === 'all' || t.status === state.filter;

  function rowHTML(t, opts = {}) {
    const late = t.due && t.status !== 'done' && t.due < today();
    const meta = [
      `<span class="tag st-${t.status}">${LABEL[t.status]}</span>`,
      t.priority === 'high' ? '<span class="hi">High priority</span>' : t.priority === 'low' ? '<span>Low priority</span>' : '',
      t.category ? `<span>${esc(t.category)}</span>` : '',
      t.due ? `<span class="${late ? 'late' : ''}">${late ? 'Overdue · ' : ''}Due ${fmtShort(t.due)}</span>` : '',
      opts.showDate ? `<span>Logged ${fmtShort(t.date)}</span>` : '',
      t.notes ? '<span>Has notes</span>' : ''
    ].filter(Boolean).join('');
    return `<li class="task s-${t.status}" data-id="${esc(t.id)}">
      <button class="st" data-act="cycle" aria-label="${esc(t.title)}: ${LABEL[t.status]}. Move to ${LABEL[NEXT[t.status]]}" title="${LABEL[t.status]} — click for ${LABEL[NEXT[t.status]]}">${ICON[t.status]}</button>
      <div class="body"><button class="title" data-act="edit">${esc(t.title)}</button><div class="meta">${meta}</div></div>
      <div class="prog"><input type="range" id="p-${esc(t.id)}" min="0" max="100" step="10" value="${t.progress}" data-act="prog" aria-label="Progress for ${esc(t.title)}"><output class="num">${t.progress}%</output></div>
    </li>`;
  }
  function listSection(title, arr, opts) {
    if (!arr.length) return '';
    return `<section class="section"><h3>${title} <span class="num">${arr.length}</span></h3><ul class="list">${sortTasks(arr).map(t => rowHTML(t, opts)).join('')}</ul></section>`;
  }

  function dayView() {
    const sel = state.selected, isToday = sel === today();
    const dayTasks = state.tasks.filter(t => t.date === sel);
    const carried = isToday ? state.tasks.filter(t => t.date < sel && t.status !== 'done') : [];
    const all = dayTasks.concat(carried);
    const count = s => all.filter(t => t.status === s).length;
    const done = count('done');
    const pct = all.length ? Math.round(all.reduce((a, t) => a + t.progress, 0) / all.length) : 0;
    const chip = (key, label, n, color) => `<button class="chip" data-act="filter" data-f="${key}" aria-pressed="${state.filter === key}">${color ? `<span class="dot" style="background:var(${color})"></span>` : ''}${label} <b>${n}</b></button>`;

    let week = '';
    for (let i = -6; i <= 0; i++) {
      const d = addDays(sel, i);
      const ts = state.tasks.filter(t => t.date === d);
      const dn = ts.filter(t => t.status === 'done').length;
      const h = ts.length ? Math.round(dn / ts.length * 100) : 0;
      week += `<button class="wd" data-act="goto" data-date="${d}" ${d === sel ? 'aria-current="date"' : ''} aria-label="${fmtLong(d)}: ${dn} of ${ts.length} done"><span class="lbl">${fmtWd(d)}</span><span class="bar"><i style="height:${h}%"></i><em>${ts.length ? dn + '/' + ts.length : '–'}</em></span><span class="num">${parse(d).getDate()}</span></button>`;
    }

    const visibleDay = dayTasks.filter(matches), visibleCarried = carried.filter(matches);
    let lists = listSection(isToday ? 'Today' : 'Logged for this day', visibleDay) + listSection('Carried over, still open', visibleCarried, { showDate: true });
    if (!all.length) lists = `<div class="empty"><strong>${isToday ? 'Nothing logged for today yet' : 'Nothing logged for this day'}</strong>Type a task in the box above and press Enter. Unfinished tasks from earlier days carry over to today automatically.</div>`;
    else if (!visibleDay.length && !visibleCarried.length) lists = `<div class="empty"><strong>No ${LABEL[state.filter].toLowerCase()} tasks here</strong><button class="linkbtn" data-act="filter" data-f="all">Show all tasks</button></div>`;

    return `
      <div class="dayhead">
        <h1><span class="eyebrow">${isToday ? 'Today' : sel < today() ? 'Past day' : 'Upcoming day'}</span>${fmtLong(sel)}</h1>
        <div class="navbtns">
          <button class="iconbtn" data-act="shift" data-n="-1" aria-label="Previous day">‹</button>
          <input type="date" class="datepick" id="datepick" value="${sel}" aria-label="Pick a day">
          <button class="iconbtn" data-act="shift" data-n="1" aria-label="Next day">›</button>
          ${isToday ? '' : `<button class="pillbtn" data-act="goto" data-date="${today()}">Today</button>`}
        </div>
      </div>
      <section class="summary" aria-label="Progress for this day">
        <div class="ring" style="--p:${pct}" role="img" aria-label="Average progress ${pct}%"><span>${pct}%</span></div>
        <div class="sumtext">
          <h2>${all.length ? `${done} of ${all.length} done` : 'No tasks yet'}</h2>
          <p>${all.length ? `Average progress across ${all.length} task${all.length === 1 ? '' : 's'}${carried.length ? `, including ${carried.length} carried over` : ''}.` : 'Your progress ring fills as you finish tasks.'}</p>
          <div class="chips">
            ${chip('all', 'All', all.length)}
            ${chip('todo', 'To do', count('todo'), '--todo')}
            ${chip('in_progress', 'In progress', count('in_progress'), '--prog')}
            ${chip('blocked', 'Blocked', count('blocked'), '--block')}
            ${chip('done', 'Done', done, '--done')}
          </div>
        </div>
        <div class="week" aria-label="Last 7 days">${week}</div>
      </section>
      ${lists}`;
  }

  function openView() {
    const t0 = today(), soon = addDays(t0, 7);
    const open = state.tasks.filter(t => t.status !== 'done');
    const overdue = open.filter(t => t.due && t.due < t0);
    const dueSoon = open.filter(t => t.due && t.due >= t0 && t.due <= soon);
    const later = open.filter(t => !t.due || t.due > soon);
    const days = []; for (let i = -13; i <= 0; i++) days.push(addDays(t0, i));
    const counts = days.map(d => state.tasks.filter(t => t.status === 'done' && isoDay(t.completedAt) === d).length);
    const max = Math.max(1, ...counts);
    const week = counts.slice(7).reduce((a, b) => a + b, 0);
    const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
    const lists = open.length
      ? listSection('Overdue', overdue, { showDate: true }) + listSection('Due in the next 7 days', dueSoon, { showDate: true }) + listSection('Later or no due date', later, { showDate: true })
      : `<div class="empty"><strong>No open tasks</strong>Everything you've logged is done. Add a new task above.</div>`;
    return `
      <div class="dayhead"><h1><span class="eyebrow">All days</span>Open tasks</h1></div>
      <div class="stats">
        ${stat(open.length, 'Open')}
        ${stat(open.filter(t => t.status === 'in_progress').length, 'In progress')}
        ${stat(open.filter(t => t.status === 'blocked').length, 'Blocked')}
        ${stat(week, 'Done in last 7 days')}
      </div>
      <div class="chart">
        <h3>Tasks completed per day · last 14 days</h3>
        <div class="bars" role="img" aria-label="Completed tasks per day over the last 14 days">${counts.map((c, i) => `<div class="${c ? '' : 'zero'}" style="height:${c ? Math.max(6, c / max * 100) : 2}%" title="${fmtShort(days[i])}: ${c} done">${c ? `<span>${c}</span>` : ''}</div>`).join('')}</div>
        <div class="blabels">${days.map(d => `<span>${parse(d).getDate()}</span>`).join('')}</div>
      </div>
      ${lists}`;
  }

  function renderSync() {
    const el = $('#sync');
    if (state.syncError) { el.textContent = navigator.onLine === false ? 'Offline — changes will not save until you reconnect.' : 'Not synced — retrying.'; el.className = 'sync bad'; }
    else if (state.lastSync) { el.textContent = 'Synced ' + state.lastSync.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); el.className = 'sync'; }
  }

  function render() {
    const cats = new Set(DEFAULT_CATS); state.tasks.forEach(t => t.category && cats.add(t.category));
    $('#cats').innerHTML = [...cats].sort().map(c => `<option value="${esc(c)}">`).join('');
    $('#qa-title').placeholder = state.view === 'day' && state.selected !== today() ? `Add a task for ${fmtShort(state.selected)}` : 'What needs doing today?';
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
    $('#notices').hidden = true;
    renderSync();
    if (!state.loaded) { $('#main').innerHTML = `<div class="empty"><strong>Loading your tasks…</strong>This takes a moment.</div>`; return; }
    $('#main').innerHTML = state.view === 'day' ? dayView() : openView();
  }

  /* ---------- edit sheet ---------- */
  let armed = false;
  function openSheet(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    state.editId = id; armed = false;
    $('#f-title').value = t.title; $('#f-notes').value = t.notes; $('#f-status').value = t.status;
    $('#f-prio').value = t.priority; $('#f-prog').value = t.progress; $('#f-prog-out').textContent = t.progress + '%';
    $('#f-cat').value = t.category; $('#f-date').value = t.date; $('#f-due').value = t.due;
    $('#f-err').textContent = ''; $('#f-del').textContent = 'Delete'; $('#f-del').classList.remove('armed');
    $('#f-stamp').textContent = [t.createdAt && 'Created ' + new Date(t.createdAt).toLocaleString(), t.completedAt && 'Completed ' + new Date(t.completedAt).toLocaleString()].filter(Boolean).join(' · ');
    $('#scrim').hidden = false;
    $('#f-title').focus();
  }
  function closeSheet() { $('#scrim').hidden = true; state.editId = null; }

  $('#f-prog').addEventListener('input', e => {
    const v = Number(e.target.value), s = $('#f-status');
    $('#f-prog-out').textContent = v + '%';
    if (v === 100) s.value = 'done';
    else if (s.value === 'done' || (v > 0 && s.value === 'todo')) s.value = 'in_progress';
  });
  $('#f-status').addEventListener('change', e => {
    const s = e.target.value, r = $('#f-prog');
    if (s === 'done') r.value = 100; else if (r.value == 100) r.value = s === 'todo' ? 0 : 50;
    $('#f-prog-out').textContent = r.value + '%';
  });
  $('#sheet').addEventListener('submit', e => {
    e.preventDefault();
    const t = state.tasks.find(x => x.id === state.editId); if (!t) return closeSheet();
    const title = $('#f-title').value.trim(), date = $('#f-date').value, due = $('#f-due').value;
    if (!title) { $('#f-err').textContent = 'Give the task a name.'; $('#f-title').focus(); return; }
    if (!validDate(date)) { $('#f-err').textContent = 'Choose the day this task is logged for.'; return; }
    let status = $('#f-status').value; const progress = Number($('#f-prog').value);
    if (progress >= 100) status = 'done';
    const patch = { title, notes: $('#f-notes').value.trim(), priority: $('#f-prio').value, category: $('#f-cat').value.trim(), date, due: validDate(due) ? due : '' };
    if (status !== t.status) Object.assign(patch, statusPatch(t, status));
    if (status !== 'done') patch.progress = progress;
    patchTask(t.id, patch);
    closeSheet();
    toast('Saved');
  });
  $('#f-cancel').addEventListener('click', closeSheet);
  $('#f-del').addEventListener('click', () => {
    if (!armed) { armed = true; $('#f-del').textContent = 'Confirm delete'; $('#f-del').classList.add('armed'); return; }
    const t = state.tasks.find(x => x.id === state.editId);
    if (t) { deleteTask(t.id); toast(`Deleted “${t.title.slice(0, 40)}”`); }
    closeSheet();
  });
  $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#scrim').hidden) closeSheet(); });

  /* ---------- main interactions ---------- */
  $('#qa').addEventListener('submit', e => {
    e.preventDefault();
    if (!state.loaded) return;
    const title = $('#qa-title').value.trim(); if (!title) return;
    const date = state.view === 'day' ? state.selected : today();
    createTask({ title, priority: $('#qa-prio').value, category: $('#qa-cat').value.trim(), date });
    $('#qa-title').value = ''; $('#qa-title').focus();
  });
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    state.view = b.dataset.view; state.filter = 'all'; render();
  });
  $('#main').addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, li = el.closest('.task'), id = li && li.dataset.id;
    if (act === 'cycle') { const t = state.tasks.find(x => x.id === id); if (t) patchTask(id, statusPatch(t, NEXT[t.status])); }
    else if (act === 'edit') openSheet(id);
    else if (act === 'filter') { state.filter = el.dataset.f; render(); }
    else if (act === 'shift') { state.selected = addDays(state.selected, Number(el.dataset.n)); state.filter = 'all'; render(); }
    else if (act === 'goto') { state.selected = el.dataset.date; state.filter = 'all'; render(); }
  });
  $('#main').addEventListener('input', e => {
    if (e.target.dataset.act === 'prog') e.target.nextElementSibling.textContent = e.target.value + '%';
  });
  $('#main').addEventListener('change', e => {
    if (e.target.id === 'datepick' && validDate(e.target.value)) { state.selected = e.target.value; state.filter = 'all'; render(); return; }
    if (e.target.dataset.act === 'prog') {
      const id = e.target.closest('.task').dataset.id, t = state.tasks.find(x => x.id === id);
      if (t) patchTask(id, progressPatch(t, Number(e.target.value)));
    }
  });

  let toastTimer;
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800); }

  /* ---------- auth ---------- */
  function show(screen) {
    $('#setup-screen').hidden = screen !== 'setup';
    $('#auth-screen').hidden = screen !== 'auth';
    $('#app').hidden = screen !== 'app';
  }
  $('#auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#auth-email').value.trim(), password = $('#auth-pass').value;
    if (!email || !password) { $('#auth-err').textContent = 'Enter your email and password.'; return; }
    $('#auth-btn').disabled = true; $('#auth-btn').textContent = 'Signing in…'; $('#auth-err').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $('#auth-btn').disabled = false; $('#auth-btn').textContent = 'Sign in';
    if (error) $('#auth-err').textContent = /invalid/i.test(error.message) ? 'That email and password do not match.' : (navigator.onLine === false ? 'You are offline. Connect and try again.' : 'Could not sign in. Try again in a moment.');
  });
  $('#signout').addEventListener('click', async () => { await sb.auth.signOut(); });

  let signedIn = false, timer = null;
  function onSession(session) {
    if (session && !signedIn) {
      signedIn = true; $('#auth-pass').value = '';
      show('app'); state.loaded = false; render(); refresh(false);
      timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, REFRESH_MS);
    } else if (!session && signedIn) {
      signedIn = false; clearInterval(timer); state.tasks = []; state.loaded = false; closeSheet(); $('#main').innerHTML = ''; show('auth');
    } else if (!session) show('auth');
  }
  document.addEventListener('visibilitychange', () => { if (signedIn && document.visibilityState === 'visible') refresh(true); });
  window.addEventListener('online', () => { if (signedIn) refresh(true); });
  window.addEventListener('offline', renderSync);

  // Roll the day over at midnight if the page stays open.
  let lastToday = today();
  setInterval(() => { const t = today(); if (t !== lastToday) { if (state.selected === lastToday) state.selected = t; lastToday = t; if (signedIn) render(); } }, 60000);

  /* ---------- boot ---------- */
  const cfg = window.TASKLOG_CONFIG || {};
  if (!window.supabase || !/^https:\/\/.+/.test(cfg.supabaseUrl || '') || !cfg.supabaseAnonKey || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
    show('setup');
    return;
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
})();
