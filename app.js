/* RT Task Log — team edition (Supabase backend).
   Roles come from public.profiles: managers see everyone's tasks and can assign work;
   members see only their own. The database enforces every rule; the UI mirrors them. */
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
  const MIN_PASSWORD = 8;

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
  function ago(iso) {
    if (!iso) return 'No activity yet';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'Updated just now';
    if (mins < 60) return `Updated ${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `Updated ${hrs} h ago`;
    const days = Math.round(hrs / 24);
    return days === 1 ? 'Updated yesterday' : `Updated ${days} days ago`;
  }

  const state = {
    me: null, profiles: {}, tasks: [], selected: today(), view: 'day', filter: 'all', person: null,
    loaded: false, editId: null, lastSync: null, online: navigator.onLine !== false, syncing: false,
    serverTasks: [],   // last copy received from the server
    outbox: []         // changes made on this device that the server hasn't confirmed yet
  };
  let sb = null;

  /* ---------- on-device storage (IndexedDB) ----------
     Each signed-in person gets one record holding their last server snapshot and their outbox,
     so the app opens and works with no connection and catches up when the connection returns. */
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('tasklog', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result); t.onerror = t.onabort = () => rej(t.error);
    }));
    return {
      get: k => tx('readonly', s => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(e => console.warn('[tasklog] local save failed', e)),
      del: k => tx('readwrite', s => s.delete(k)).catch(() => {})
    };
  })();
  const cacheKey = () => 'user:' + state.me.id;
  let saveTimer = null;
  function persist() {           // debounced: one write per burst of changes
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!state.me) return;
      idb.set(cacheKey(), { me: state.me, profiles: state.profiles, serverTasks: state.serverTasks, outbox: state.outbox,
        lastSync: state.lastSync ? state.lastSync.toISOString() : null });
    }, 150);
  }

  /* ---------- roles & permissions (mirror of the database rules) ---------- */
  const isManager = () => !!(state.me && state.me.role === 'manager');
  const nameOf = id => (state.profiles[id] && state.profiles[id].name) || (id === state.me?.id ? 'You' : 'Your manager');
  const mine = () => state.tasks.filter(t => t.userId === state.me.id);
  const canProgress = t => t.userId === state.me.id;
  const lockedDetails = t => !!t.assignedBy && t.assignedBy !== state.me.id;            // member on an assigned task
  const canEditDetails = t => t.userId === state.me.id || t.assignedBy === state.me.id;
  const canDelete = t => (t.userId === state.me.id && !t.assignedBy) || t.assignedBy === state.me.id;
  const teamMembers = () => Object.values(state.profiles)
    .filter(p => p.active && p.id !== state.me.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  /* ---------- row <-> app model ---------- */
  function fromRow(r) {
    return {
      id: r.id, userId: r.user_id, assignedBy: r.assigned_by || null,
      title: r.title, notes: r.notes || '', date: r.log_date, due: r.due_date || '',
      priority: PRIO[r.priority] !== undefined ? r.priority : 'normal', category: r.category || '',
      status: LABEL[r.status] ? r.status : 'todo', progress: r.progress || 0, prevProgress: r.prev_progress || 0,
      completedAt: r.completed_at || '', createdAt: r.created_at || '', updatedAt: r.updated_at || ''
    };
  }
  const fromProfile = p => ({ id: p.id, email: p.email || '', name: p.display_name || p.email || 'Member', role: p.role || 'member', active: p.active !== false, mustChange: !!p.must_change_password });
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
  async function loadTasks() {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('tasks').select('*').order('created_at', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    return rows.map(fromRow);
  }
  async function loadProfiles() {
    let res;
    try { res = await sb.from('profiles').select('*'); } catch (e) { return null; }
    const { data, error } = res || {};
    if (error || !Array.isArray(data)) return null;   // team upgrade not installed yet: run as a single-user app
    const map = {}; data.forEach(p => { map[p.id] = fromProfile(p); });
    return map;
  }
  /* ---------- sync engine ----------
     Every change is applied on screen at once, stored in the outbox, then sent to the server
     in order. Network failures leave it in the outbox for the next attempt; a refusal from the
     server (a rule was broken) drops it and reloads, so a bad change can't block the queue. */
  const isNetworkError = r => !r || r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500
    || navigator.onLine === false || /fetch|network|Load failed/i.test((r.error && r.error.message) || '');
  
  function applyOps(base, ops) {
    let list = base.map(t => ({ ...t }));
    for (const op of ops) {
      if (op.kind === 'insert') { if (!list.some(t => t.id === op.task.id)) list.push({ ...op.task }); }
      else if (op.kind === 'update') { const t = list.find(x => x.id === op.id); if (t) Object.assign(t, op.patch); }
      else if (op.kind === 'delete') list = list.filter(t => t.id !== op.id);
    }
    return list;
  }
  function rebuild() { state.tasks = applyOps(state.serverTasks, state.outbox); }

  // Keep the outbox short: fold repeated edits of one task into a single change.
  function queueOp(op) {
    const ob = state.outbox;
    const last = [...ob].reverse().find(o => (o.id || o.task.id) === op.id);
    // Changes to different tasks are independent, so a task's edits can be folded into its latest pending change.
    if (op.kind === 'update' && last && last.kind === 'insert') Object.assign(last.task, op.patch);
    else if (op.kind === 'update' && last && last.kind === 'update') Object.assign(last.patch, op.patch);
    else if (op.kind === 'delete' && last && last.kind === 'insert') {
      state.outbox = ob.filter(o => (o.id || o.task.id) !== op.id);   // created and deleted offline: nothing to send
    } else ob.push({ ...op, at: new Date().toISOString() });
    rebuild(); render(); persist(); flush();
  }

  function sendOp(op) {
    if (op.kind === 'insert') {
      const t = op.task, row = { id: t.id, ...toRow(t) };
      if (t.assignedBy) { row.user_id = t.userId; row.assigned_by = t.assignedBy; }
      return sb.from('tasks').insert(row);
    }
    if (op.kind === 'update') return sb.from('tasks').update(toRow(op.patch)).eq('id', op.id);
    return sb.from('tasks').delete().eq('id', op.id);
  }

  // 'ok' = signed in and reachable · 'offline' = try later · 'signed-out' = the server no longer accepts this sign-in
  async function ensureSession() {
    let r;
    try { r = await sb.auth.getSession(); } catch (e) { return 'offline'; }
    if (r && r.data && r.data.session) return 'ok';
    const e = r && r.error;
    if (navigator.onLine === false || (e && (e.status === 0 || /Retryable|fetch|network/i.test(`${e.name} ${e.message}`)))) return 'offline';
    return 'signed-out';
  }
  // Sign-in is no longer valid (e.g. password reset). Keep unsynced changes on the device for next sign-in.
  async function sessionLost() {
    clearTimeout(saveTimer);
    if (state.me) await idb.set(cacheKey(), { me: state.me, profiles: state.profiles, serverTasks: state.serverTasks, outbox: state.outbox,
      lastSync: state.lastSync ? state.lastSync.toISOString() : null });
    const n = state.outbox.length;
    await sb.auth.signOut({ scope: 'local' });
    $('#auth-err').textContent = n ? `Please sign in again. Your ${n} unsynced change${n === 1 ? ' is' : 's are'} kept on this device and will sync after you sign in.` : 'Please sign in again.';
  }

  let flushing = null;
  function flush() {
    if (flushing || !sb || !state.me || !state.outbox.length) return flushing;
    flushing = (async () => {
      const auth = await ensureSession();
      if (auth !== 'ok') { flushing = null; if (auth === 'signed-out') await sessionLost(); else { state.online = false; renderSync(); } return; }
      state.syncing = true; renderSync();
      let rejected = 0, lastMsg = '';
      while (state.outbox.length) {
        const op = state.outbox[0];
        let res;
        try { res = await sendOp(op); } catch (e) { res = { error: e, status: 0 }; }
        const err = res && res.error;
        if (err && err.code !== '23505' && isNetworkError(res)) { state.online = false; break; }   // offline: try again later
        if (err && (res.status === 401 || /JWT/.test(err.message || ''))) break;              // sign-in needs renewing: keep the change
        if (err && err.code !== '23505') {                                     // refused by the database
          rejected++; lastMsg = err.message || '';
          console.error('[tasklog] change refused', op, err);
        } else confirmOp(op);
        state.outbox.shift(); persist();
      }
      state.syncing = false;
      if (rejected) {
        toast(/assigned task|another person/.test(lastMsg) ? lastMsg
          : rejected === 1 ? 'One change could not be saved and was undone.' : `${rejected} changes could not be saved and were undone.`);
      }
      flushing = null;
      if (!state.outbox.length) await refresh(true); else { rebuild(); render(); }
    })();
    return flushing;
  }
  // Reflect a confirmed change in the server copy so the screen doesn't flicker before the next refresh.
  function confirmOp(op) {
    if (op.kind === 'insert') { if (!state.serverTasks.some(t => t.id === op.task.id)) state.serverTasks.push({ ...op.task }); }
    else if (op.kind === 'update') { const t = state.serverTasks.find(x => x.id === op.id); if (t) Object.assign(t, op.patch); }
    else state.serverTasks = state.serverTasks.filter(t => t.id !== op.id);
    state.lastSync = new Date();
  }

  let refreshing = null;
  function refresh(quiet) {
    if (refreshing || !sb || !state.me) return refreshing;
    refreshing = (async () => {
      try {
        const auth = await ensureSession();
        if (auth === 'signed-out') { await sessionLost(); return; }
        if (auth === 'offline') throw { offline: true };
        const [tasks, profiles] = await Promise.all([loadTasks(), loadProfiles()]);
        if (profiles) {
          state.profiles = profiles;
          const p = profiles[state.me.id];
          if (p) {
            if (!p.active) { toast('Your account is no longer active. Ask your manager.'); await signOut(true); return; }
            state.me = p;
          }
        }
        state.serverTasks = tasks; state.lastSync = new Date(); state.online = true;
        rebuild(); state.loaded = true;
        if (state.editId && !state.tasks.some(t => t.id === state.editId)) closeSheet();
        if (state.view === 'team' && !isManager()) state.view = 'day';
        persist(); render();
      } catch (e) {
        state.online = false; renderSync();
        if (!quiet && !state.loaded) toast('You are offline. Showing tasks saved on this device.');
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function createTask(fields, ownerId) {
    const now = new Date().toISOString();
    const assigning = ownerId && ownerId !== state.me.id;
    const t = { id: uuid(), userId: assigning ? ownerId : state.me.id, assignedBy: assigning ? state.me.id : null,
      title: fields.title, notes: fields.notes || '', date: fields.date, due: fields.due || '', priority: fields.priority || 'normal',
      category: fields.category || '', status: 'todo', progress: 0, prevProgress: 0, completedAt: '', createdAt: now, updatedAt: now };
    queueOp({ kind: 'insert', id: t.id, task: t });
  }
  function patchTask(id, patch) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    // Send only fields that changed, so people editing different fields of one task don't overwrite each other.
    const changed = {};
    for (const [k, v] of Object.entries(patch)) if (t[k] !== v) changed[k] = v;
    if (!Object.keys(changed).length) return;
    // Status and progress travel together so the database's "Done = 100%" rule always sees a consistent pair.
    if ('status' in changed || 'progress' in changed) {
      changed.status = changed.status ?? t.status; changed.progress = changed.progress ?? t.progress;
      if (!('completedAt' in changed)) changed.completedAt = t.completedAt;
    }
    changed.updatedAt = new Date().toISOString();
    queueOp({ kind: 'update', id, patch: changed });
  }
  function deleteTask(id) { queueOp({ kind: 'delete', id }); }

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

  /* ---------- shared view pieces ---------- */
  const dueKey = t => t.due || '9999-12-31';
  const sortTasks = arr => arr.slice().sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (PRIO[a.priority] - PRIO[b.priority])
    || dueKey(a).localeCompare(dueKey(b)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const matches = t => state.filter === 'all' || t.status === state.filter;
  const isOverdue = t => t.due && t.status !== 'done' && t.due < today();

  function rowHTML(t, opts = {}) {
    const late = isOverdue(t);
    const assignedTag = t.assignedBy
      ? `<span class="tag as">${t.assignedBy === state.me.id ? (t.userId === state.me.id ? 'Assigned' : 'Assigned by you') : 'Assigned by ' + esc(nameOf(t.assignedBy))}</span>` : '';
    const meta = [
      `<span class="tag st-${t.status}">${LABEL[t.status]}</span>`,
      assignedTag,
      opts.showOwner ? `<span class="owner">${esc(nameOf(t.userId))}</span>` : '',
      t.priority === 'high' ? '<span class="hi">High priority</span>' : t.priority === 'low' ? '<span>Low priority</span>' : '',
      t.category ? `<span>${esc(t.category)}</span>` : '',
      t.due ? `<span class="${late ? 'late' : ''}">${late ? 'Overdue · ' : ''}Due ${fmtShort(t.due)}</span>` : '',
      opts.showDate ? `<span>Logged ${fmtShort(t.date)}</span>` : '',
      t.notes ? '<span>Has notes</span>' : ''
    ].filter(Boolean).join('');
    const own = canProgress(t);
    const st = own
      ? `<button class="st" data-act="cycle" aria-label="${esc(t.title)}: ${LABEL[t.status]}. Move to ${LABEL[NEXT[t.status]]}" title="${LABEL[t.status]} — click for ${LABEL[NEXT[t.status]]}">${ICON[t.status]}</button>`
      : `<span class="st" role="img" aria-label="${LABEL[t.status]}">${ICON[t.status]}</span>`;
    const prog = own
      ? `<input type="range" id="p-${esc(t.id)}" min="0" max="100" step="10" value="${t.progress}" data-act="prog" aria-label="Progress for ${esc(t.title)}"><output class="num">${t.progress}%</output>`
      : `<span class="pbar" role="img" aria-label="Progress ${t.progress}%"><i style="width:${t.progress}%"></i></span><output class="num">${t.progress}%</output>`;
    return `<li class="task s-${t.status}" data-id="${esc(t.id)}">
      ${st}
      <div class="body"><button class="title" data-act="edit">${esc(t.title)}</button><div class="meta">${meta}</div></div>
      <div class="prog">${prog}</div>
    </li>`;
  }
  function listSection(title, arr, opts, sorted) {
    if (!arr.length) return '';
    const items = sorted ? arr : sortTasks(arr);
    return `<section class="section"><h3>${title} <span class="num">${arr.length}</span></h3><ul class="list">${items.map(t => rowHTML(t, opts)).join('')}</ul></section>`;
  }
  const stat = (v, k, warn) => `<div class="stat${warn && v ? ' warn' : ''}"><div class="v">${v}</div><div class="k">${k}</div></div>`;

  /* ---------- Day view (your own tasks) ---------- */
  function dayView() {
    const tasks = mine();
    const sel = state.selected, isToday = sel === today();
    const dayTasks = tasks.filter(t => t.date === sel);
    const carried = isToday ? tasks.filter(t => t.date < sel && t.status !== 'done') : [];
    const all = dayTasks.concat(carried);
    const count = s => all.filter(t => t.status === s).length;
    const done = count('done');
    const pct = all.length ? Math.round(all.reduce((a, t) => a + t.progress, 0) / all.length) : 0;
    const chip = (key, label, n, color) => `<button class="chip" data-act="filter" data-f="${key}" aria-pressed="${state.filter === key}">${color ? `<span class="dot" style="background:var(${color})"></span>` : ''}${label} <b>${n}</b></button>`;

    let week = '';
    for (let i = -6; i <= 0; i++) {
      const d = addDays(sel, i);
      const ts = tasks.filter(t => t.date === d);
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

  /* ---------- Open tasks view (your own) ---------- */
  function openView() {
    const tasks = mine();
    const t0 = today(), soon = addDays(t0, 7);
    const open = tasks.filter(t => t.status !== 'done');
    const overdue = open.filter(t => t.due && t.due < t0);
    const dueSoon = open.filter(t => t.due && t.due >= t0 && t.due <= soon);
    const later = open.filter(t => !t.due || t.due > soon);
    const days = []; for (let i = -13; i <= 0; i++) days.push(addDays(t0, i));
    const counts = days.map(d => tasks.filter(t => t.status === 'done' && isoDay(t.completedAt) === d).length);
    const max = Math.max(1, ...counts);
    const week = counts.slice(7).reduce((a, b) => a + b, 0);
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

  /* ---------- Team view (managers) ---------- */
  function personStats(id) {
    const t0 = today(), weekStart = addDays(t0, -6);
    const ts = state.tasks.filter(t => t.userId === id);
    const open = ts.filter(t => t.status !== 'done');
    const todayAll = ts.filter(t => t.date === t0 || (t.date < t0 && t.status !== 'done'));
    return {
      tasks: ts, open,
      inProgress: open.filter(t => t.status === 'in_progress').length,
      blocked: open.filter(t => t.status === 'blocked').length,
      overdue: open.filter(isOverdue).length,
      doneWeek: ts.filter(t => t.status === 'done' && isoDay(t.completedAt) >= weekStart).length,
      todayDone: todayAll.filter(t => t.status === 'done').length, todayTotal: todayAll.length,
      lastUpdate: ts.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), '')
    };
  }

  function teamView() {
    const people = teamMembers();
    if (state.person && state.profiles[state.person]) return personView(state.profiles[state.person]);
    if (!people.length) return `
      <div class="dayhead"><h1><span class="eyebrow">Team</span>Your team</h1></div>
      <div class="empty"><strong>No team members yet</strong>Add people in Supabase under Authentication → Users → Add user. They appear here after their first sign-in.</div>`;

    const rows = people.map(p => ({ p, s: personStats(p.id) }))
      .sort((a, b) => (b.s.blocked + b.s.overdue) - (a.s.blocked + a.s.overdue) || a.p.name.localeCompare(b.p.name));
    const sum = k => rows.reduce((a, r) => a + r.s[k], 0);
    const openAll = rows.reduce((a, r) => a + r.s.open.length, 0);
    const attention = rows.flatMap(r => r.s.open.filter(t => t.status === 'blocked' || isOverdue(t)))
      .sort((a, b) => (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1) || dueKey(a).localeCompare(dueKey(b)));

    const cards = rows.map(({ p, s }) => {
      const pct = s.todayTotal ? Math.round(s.todayDone / s.todayTotal * 100) : 0;
      return `<li><button class="person" data-act="person" data-id="${esc(p.id)}">
        <span class="pname">${esc(p.name)}${p.role === 'manager' ? ' <span class="tag as">Manager</span>' : ''}</span>
        <span class="plast">${ago(s.lastUpdate)}</span>
        <span class="ptoday"><span class="pbar"><i style="width:${pct}%"></i></span><span class="num">Today ${s.todayDone}/${s.todayTotal}</span></span>
        <span class="pchips">
          <span class="mini">Open <b class="num">${s.open.length}</b></span>
          <span class="mini">In progress <b class="num">${s.inProgress}</b></span>
          <span class="mini${s.blocked ? ' bad' : ''}">Blocked <b class="num">${s.blocked}</b></span>
          <span class="mini${s.overdue ? ' bad' : ''}">Overdue <b class="num">${s.overdue}</b></span>
          <span class="mini">Done 7d <b class="num">${s.doneWeek}</b></span>
        </span>
      </button></li>`;
    }).join('');

    return `
      <div class="dayhead"><h1><span class="eyebrow">Team · ${fmtLong(today())}</span>Your team</h1></div>
      <div class="stats">
        ${stat(people.length, 'People')}
        ${stat(openAll, 'Open tasks')}
        ${stat(sum('blocked'), 'Blocked', true)}
        ${stat(sum('overdue'), 'Overdue', true)}
      </div>
      ${listSection('Needs attention', attention, { showOwner: true, showDate: true }, true)}
      <section class="section"><h3>People <span class="num">${people.length}</span></h3><ul class="people">${cards}</ul></section>`;
  }

  function personView(p) {
    const s = personStats(p.id), weekStart = addDays(today(), -6);
    const doneRecent = s.tasks.filter(t => t.status === 'done' && isoDay(t.completedAt) >= weekStart)
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    const overdue = s.open.filter(isOverdue), rest = s.open.filter(t => !isOverdue(t));
    const lists = (s.open.length || doneRecent.length)
      ? listSection('Overdue', overdue, { showDate: true }) + listSection('Open', rest, { showDate: true }) + listSection('Done in the last 7 days', doneRecent, { showDate: true }, true)
      : `<div class="empty"><strong>${esc(p.name)} has no tasks yet</strong>Use the form above to assign their first task.</div>`;
    return `
      <div><button class="linkbtn" data-act="team-home">‹ All team</button></div>
      <div class="dayhead"><h1><span class="eyebrow">${esc(p.email)} · ${ago(s.lastUpdate)}</span>${esc(p.name)}</h1></div>
      <div class="stats">
        ${stat(`${s.todayDone}/${s.todayTotal}`, 'Done today')}
        ${stat(s.open.length, 'Open')}
        ${stat(s.blocked, 'Blocked', true)}
        ${stat(s.overdue, 'Overdue', true)}
      </div>
      ${lists}`;
  }

  /* ---------- render ---------- */
  function renderSync() {
    if (!state.me) return;
    const n = state.outbox.length, changes = `${n} change${n === 1 ? '' : 's'}`;
    const offline = !state.online || navigator.onLine === false;
    const when = state.lastSync ? state.lastSync.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    const lastDay = state.lastSync && ymd(state.lastSync) !== today() ? ' on ' + fmtShort(ymd(state.lastSync)) : '';
    let txt, pill = '', cls = 'sync';
    if (offline) {
      pill = n ? `Offline · ${n} waiting` : 'Offline';
      txt = n ? `Offline. ${changes} saved on this device will sync when you reconnect.`
        : `Offline. Showing tasks saved on this device${when ? `, last synced ${when}${lastDay}` : ''}.`;
      cls = 'sync warn';
    } else if (n) { pill = `Syncing ${n}…`; txt = `Syncing ${changes}…`; }
    else txt = when ? `All changes saved · Synced ${when}${lastDay}` : '';
    const el = $('#sync'); el.textContent = txt; el.className = cls;
    const pe = $('#netpill'); pe.textContent = pill; pe.hidden = !pill; pe.classList.toggle('off', offline);
    $('#privacy').hidden = isManager() || !state.loaded;
  }

  function renderAssignForm() {
    const form = $('#assign');
    const show = state.view === 'team' && isManager() && teamMembers().length > 0;
    form.hidden = !show;
    if (!show) return;
    const sel = $('#as-who');
    const want = state.person || sel.value;
    const opts = teamMembers().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (sel.dataset.opts !== opts) { sel.innerHTML = '<option value="">Assign to…</option>' + opts; sel.dataset.opts = opts; }
    if (state.person) sel.value = state.person; else if (want && state.profiles[want]) sel.value = want; else sel.value = '';
  }

  function render() {
    if (!state.me) return;
    const cats = new Set(DEFAULT_CATS); state.tasks.forEach(t => t.category && cats.add(t.category));
    $('#cats').innerHTML = [...cats].sort().map(c => `<option value="${esc(c)}">`).join('');
    $('#tab-team').hidden = !isManager();
    $('#qa').hidden = state.view === 'team';
    $('#qa-title').placeholder = state.view === 'day' && state.selected !== today() ? `Add a task for ${fmtShort(state.selected)}` : 'What needs doing today?';
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
    $('#acct-btn').textContent = state.me.name;
    renderAssignForm();
    renderSync();
    if (!state.loaded) { $('#main').innerHTML = `<div class="empty"><strong>Loading tasks…</strong>This takes a moment.</div>`; return; }
    $('#main').innerHTML = state.view === 'team' ? teamView() : state.view === 'open' ? openView() : dayView();
  }

  /* ---------- edit sheet ---------- */
  let armed = false;
  function openSheet(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    state.editId = id; armed = false;
    const own = canProgress(t), details = canEditDetails(t), locked = lockedDetails(t);
    $('#sh-h').textContent = own ? 'Edit task' : details ? `Task for ${nameOf(t.userId)}` : `${nameOf(t.userId)}'s task`;
    $('#f-title').value = t.title; $('#f-notes').value = t.notes; $('#f-status').value = t.status;
    $('#f-prio').value = t.priority; $('#f-prog').value = t.progress; $('#f-prog-out').textContent = t.progress + '%';
    $('#f-cat').value = t.category; $('#f-date').value = t.date; $('#f-due').value = t.due;
    $('#f-err').textContent = ''; $('#f-del').textContent = 'Delete'; $('#f-del').classList.remove('armed');
    $('#f-del').hidden = !canDelete(t);
    $('#f-save').hidden = !details;
    $('#f-cancel').textContent = details ? 'Cancel' : 'Close';
    ['#f-notes', '#f-prio', '#f-cat', '#f-date'].forEach(s => { $(s).disabled = !details; });
    ['#f-title', '#f-due'].forEach(s => { $(s).disabled = !details || locked; });
    ['#f-status', '#f-prog'].forEach(s => { $(s).disabled = !own; });
    const hint = locked ? `Assigned by ${nameOf(t.assignedBy)}. You can update status, progress and notes; only they can rename or re-date it.`
      : !own && details ? `${nameOf(t.userId)} updates the status and progress.`
      : !details ? 'View only. Only the owner can change this task.' : '';
    $('#f-hint').textContent = hint; $('#f-hint').hidden = !hint;
    $('#f-stamp').textContent = [t.createdAt && 'Created ' + new Date(t.createdAt).toLocaleString(), t.completedAt && 'Completed ' + new Date(t.completedAt).toLocaleString()].filter(Boolean).join(' · ');
    $('#scrim').hidden = false;
    (details ? (locked ? $('#f-notes') : $('#f-title')) : $('#f-cancel')).focus();
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
    const t = state.tasks.find(x => x.id === state.editId); if (!t || !canEditDetails(t)) return closeSheet();
    const title = $('#f-title').value.trim(), date = $('#f-date').value, due = $('#f-due').value;
    if (!title) { $('#f-err').textContent = 'Give the task a name.'; $('#f-title').focus(); return; }
    if (!validDate(date)) { $('#f-err').textContent = 'Choose the day this task is logged for.'; return; }
    const patch = { notes: $('#f-notes').value.trim(), priority: $('#f-prio').value, category: $('#f-cat').value.trim(), date };
    if (!lockedDetails(t)) { patch.title = title; patch.due = validDate(due) ? due : ''; }
    if (canProgress(t)) {
      let status = $('#f-status').value; const progress = Number($('#f-prog').value);
      if (progress >= 100) status = 'done';
      if (status !== t.status) Object.assign(patch, statusPatch(t, status));
      if (status !== 'done') patch.progress = progress;
    }
    patchTask(t.id, patch);
    closeSheet();
    toast('Saved');
  });
  $('#f-cancel').addEventListener('click', closeSheet);
  $('#f-del').addEventListener('click', () => {
    if (!armed) { armed = true; $('#f-del').textContent = 'Confirm delete'; $('#f-del').classList.add('armed'); return; }
    const t = state.tasks.find(x => x.id === state.editId);
    if (t && canDelete(t)) { deleteTask(t.id); toast(`Deleted “${t.title.slice(0, 40)}”`); }
    closeSheet();
  });
  $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });

  /* ---------- account panel ---------- */
  function openAccount() {
    signoutArmed = false; $('#ac-signout').textContent = 'Sign out';
    $('#ac-name').value = state.me.name; $('#ac-pass').value = ''; $('#ac-pass2').value = ''; $('#ac-err').textContent = '';
    $('#ac-who').textContent = `${state.me.email} · ${isManager() ? 'Manager' : 'Team member'}`;
    $('#acct-scrim').hidden = false; $('#ac-name').focus();
  }
  const closeAccount = () => { $('#acct-scrim').hidden = true; };
  $('#acct-btn').addEventListener('click', openAccount);
  $('#ac-cancel').addEventListener('click', closeAccount);
  $('#acct-scrim').addEventListener('click', e => { if (e.target.id === 'acct-scrim') closeAccount(); });
  let signoutArmed = false;
  $('#ac-signout').addEventListener('click', async () => {
    const n = state.outbox.length;
    if (n && !signoutArmed) {
      signoutArmed = true;
      $('#ac-err').textContent = `${n} change${n === 1 ? ' has' : 's have'} not synced yet. Signing out now deletes ${n === 1 ? 'it' : 'them'}. Connect to the internet first, or tap Sign out again to discard.`;
      $('#ac-signout').textContent = 'Sign out anyway'; return;
    }
    closeAccount(); await signOut(true);
  });
  // Sign out and wipe this person's tasks from the device (important on shared computers).
  async function signOut(clearDevice) {
    if (clearDevice && state.me) await idb.del(cacheKey());
    const { error } = navigator.onLine === false ? { error: true } : await sb.auth.signOut();
    if (error) await sb.auth.signOut({ scope: 'local' });
  }
  $('#acct').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#ac-name').value.trim(), p1 = $('#ac-pass').value, p2 = $('#ac-pass2').value;
    const err = checkNameAndPassword(name, p1, p2, false); if (err) { $('#ac-err').textContent = err; return; }
    const btn = $('#ac-save'); btn.disabled = true;
    const msg = await saveAccount(name, p1, false);
    btn.disabled = false;
    if (msg) { $('#ac-err').textContent = msg; return; }
    closeAccount(); toast(p1 ? 'Name and password saved' : 'Saved'); render();
  });

  function checkNameAndPassword(name, p1, p2, required) {
    if (!name) return 'Enter your name.';
    if (name.length > 60) return 'Keep your name under 60 characters.';
    if (required || p1 || p2) {
      if (p1.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`;
      if (p1 !== p2) return 'The two passwords do not match.';
    }
    return '';
  }
  async function saveAccount(name, password, firstRun) {
    if (navigator.onLine === false) return 'You are offline. Connect to the internet to change your name or password.';
    if (password) {
      const { error } = await sb.auth.updateUser({ password });
      if (error) return /same|different/i.test(error.message) ? 'Choose a password different from your temporary one.' : 'Could not change your password. Try again.';
    }
    const patch = {};
    if (name !== state.me.name) patch.display_name = name;
    if (firstRun) patch.must_change_password = false;
    if (Object.keys(patch).length && state.profiles[state.me.id]) {
      const { error } = await sb.from('profiles').update(patch).eq('id', state.me.id);
      if (error) return 'Could not save your name. Try again.';
    }
    state.me = { ...state.me, name, mustChange: false };
    state.profiles[state.me.id] = state.me;
    return '';
  }

  /* ---------- first sign-in ---------- */
  $('#welcome-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#wl-name').value.trim(), p1 = $('#wl-pass').value, p2 = $('#wl-pass2').value;
    const err = checkNameAndPassword(name, p1, p2, true); if (err) { $('#wl-err').textContent = err; return; }
    $('#wl-btn').disabled = true; $('#wl-btn').textContent = 'Saving…';
    const msg = await saveAccount(name, p1, true);
    $('#wl-btn').disabled = false; $('#wl-btn').textContent = 'Save and continue';
    if (msg) { $('#wl-err').textContent = msg; return; }
    startApp();
  });

  /* ---------- main interactions ---------- */
  $('#qa').addEventListener('submit', e => {
    e.preventDefault();
    if (!state.loaded) return;
    const title = $('#qa-title').value.trim(); if (!title) return;
    const date = state.view === 'day' ? state.selected : today();
    createTask({ title, priority: $('#qa-prio').value, category: $('#qa-cat').value.trim(), date });
    $('#qa-title').value = ''; $('#qa-title').focus();
  });
  $('#assign').addEventListener('submit', e => {
    e.preventDefault();
    if (!state.loaded || !isManager()) return;
    const who = $('#as-who').value, title = $('#as-title').value.trim(), due = $('#as-due').value;
    if (!who) { toast('Choose who the task is for.'); $('#as-who').focus(); return; }
    if (!title) { $('#as-title').focus(); return; }
    createTask({ title, due: validDate(due) ? due : '', priority: $('#as-prio').value, date: today() }, who);
    toast(`Assigned to ${nameOf(who)}`);
    $('#as-title').value = ''; $('#as-due').value = ''; $('#as-prio').value = 'normal'; $('#as-title').focus();
  });
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    state.view = b.dataset.view; state.filter = 'all'; state.person = null; $('#as-who').value = ''; render();
  });
  $('#main').addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, li = el.closest('.task'), id = li && li.dataset.id;
    if (act === 'cycle') { const t = state.tasks.find(x => x.id === id); if (t && canProgress(t)) patchTask(id, statusPatch(t, NEXT[t.status])); }
    else if (act === 'edit') openSheet(id);
    else if (act === 'filter') { state.filter = el.dataset.f; render(); }
    else if (act === 'shift') { state.selected = addDays(state.selected, Number(el.dataset.n)); state.filter = 'all'; render(); }
    else if (act === 'goto') { state.selected = el.dataset.date; state.filter = 'all'; render(); }
    else if (act === 'person') { state.person = el.dataset.id; render(); window.scrollTo(0, 0); }
    else if (act === 'team-home') { state.person = null; $('#as-who').value = ''; render(); }
  });
  $('#main').addEventListener('input', e => {
    if (e.target.dataset.act === 'prog') e.target.nextElementSibling.textContent = e.target.value + '%';
  });
  $('#main').addEventListener('change', e => {
    if (e.target.id === 'datepick' && validDate(e.target.value)) { state.selected = e.target.value; state.filter = 'all'; render(); return; }
    if (e.target.dataset.act === 'prog') {
      const id = e.target.closest('.task').dataset.id, t = state.tasks.find(x => x.id === id);
      if (t && canProgress(t)) patchTask(id, progressPatch(t, Number(e.target.value)));
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#scrim').hidden) closeSheet();
    if (!$('#acct-scrim').hidden) closeAccount();
  });

  let toastTimer;
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200); }

  /* ---------- auth ---------- */
  function show(screen) {
    ['setup', 'auth', 'welcome', 'app'].forEach(s => { $('#' + (s === 'app' ? 'app' : s + '-screen')).hidden = screen !== s; });
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

  let signedIn = false, timer = null;
  function startApp(cached) {
    show('app');
    if (cached && Array.isArray(cached.serverTasks)) {
      // Open instantly from the device copy, then catch up with the server.
      state.serverTasks = cached.serverTasks; state.outbox = cached.outbox || [];
      state.lastSync = cached.lastSync ? new Date(cached.lastSync) : null;
      rebuild(); state.loaded = true;
    } else state.loaded = false;
    render();
    refresh(false).then(() => flush());
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === 'visible') { flush(); refresh(true); } }, REFRESH_MS);
  }
  async function onSession(session) {
    if (session && !signedIn) {
      signedIn = true; $('#auth-pass').value = '';
      const uid = session.user.id;
      state.me = { id: uid, email: session.user.email || '', name: session.user.email || 'Me', role: 'member', active: true, mustChange: false };
      const cached = await idb.get('user:' + uid);
      const profiles = await loadProfiles();
      if (profiles) { state.profiles = profiles; if (profiles[uid]) state.me = profiles[uid]; }
      else if (cached && cached.me) { state.profiles = cached.profiles || {}; state.me = cached.me; }   // offline: use the device copy
      if (!state.me.active) { toast('Your account is no longer active. Ask your manager.'); await signOut(true); return; }
      if (state.me.mustChange) {
        $('#wl-name').value = state.me.name; $('#wl-err').textContent = '';
        show('welcome'); $('#wl-name').focus();
      } else startApp(cached);
    } else if (!session && signedIn) {
      signedIn = false; clearInterval(timer); clearTimeout(saveTimer);
      Object.assign(state, { me: null, profiles: {}, tasks: [], serverTasks: [], outbox: [], lastSync: null, loaded: false, view: 'day', person: null });
      closeSheet(); closeAccount(); $('#main').innerHTML = ''; $('#netpill').hidden = true; show('auth');
    } else if (!session) {
      const stored = storedUser();
      const cached = stored && navigator.onLine === false ? await idb.get('user:' + stored.id) : null;
      if (cached && cached.me && !cached.me.mustChange) {
        // Offline and the sign-in token needs renewing: open from the device copy; it renews when back online.
        signedIn = true; state.me = cached.me; state.profiles = cached.profiles || {}; state.online = false;
        startApp(cached);
      } else show('auth');
    }
  }
  function storedUser() {
    try {
      const ref = new URL(cfg.supabaseUrl).hostname.split('.')[0];
      const raw = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`) || 'null');
      const u = raw && (raw.user || (raw.currentSession && raw.currentSession.user));
      return u && u.id ? { id: u.id, email: u.email } : null;
    } catch (e) { return null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (signedIn && state.loaded && document.visibilityState === 'visible') { flush(); refresh(true); }
  });
  window.addEventListener('online', () => { state.online = true; renderSync(); if (signedIn && state.loaded) { flush(); refresh(true); } });
  window.addEventListener('offline', () => { state.online = false; renderSync(); });

  // Roll the day over at midnight if the page stays open.
  let lastToday = today();
  setInterval(() => { const t = today(); if (t !== lastToday) { if (state.selected === lastToday) state.selected = t; lastToday = t; if (signedIn && state.loaded) render(); } }, 60000);

  /* ---------- boot ---------- */
  const cfg = window.TASKLOG_CONFIG || {};
  if (!window.supabase || !/^https:\/\/.+/.test(cfg.supabaseUrl || '') || !cfg.supabaseAnonKey || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
    show('setup');
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('[tasklog] offline support unavailable', e));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  sb.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
})();
