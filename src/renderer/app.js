'use strict';
/* MCServerSmith renderer — vanilla JS SPA, no build step, no framework. */

const api = window.mcss;

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 1000) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

async function call(promise) {
  const res = await promise;
  if (!res) return null;
  if (res.ok === false) {
    const err = new Error(res.error || 'Unknown error');
    err.code = res.code; err.warnings = res.warnings; err.feature = res.feature;
    throw err;
  }
  return res.data;
}

// ---------------------------------------------------------------- state
const state = {
  view: 'welcome',
  tab: 'overview',
  activeId: null,
  instances: [],
  statuses: {},
  console: {},
  providers: [],
  versions: {},
  loaders: {},
  settings: {},
  appInfo: {},
  monetize: {},
  license: { tier: 'free', features: [] },
  languages: [],
  lang: 'en',
  dict: {},
  fallback: {},
  upsell: null,
  wizard: null,
  busy: {},
  autoScroll: true,
  autoScrollManual: false,
  consoleFilter: '',
  consoleScroll: 0,
  files: {},
  filesMenu: null,
  filesFilter: '',
  filesSort: { key: 'name', dir: 1 },
  lastConsoleId: null
};

// ---------------------------------------------------------------- i18n
function t(key, vars) {
  const raw = (state.dict && state.dict[key]) || (state.fallback && state.fallback[key]) || key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

async function loadLanguage(code) {
  try {
    state.dict = await call(api.i18n.get(code)) || {};
  } catch {
    state.dict = {};
  }
}

function applyStaticI18n() {
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

// ---------------------------------------------------------------- toasts
function toast(message, kind = 'info', ms = 4200) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${esc(message)}</div>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
}

function notifyError(err) {
  const msg = err && err.message ? err.message : String(err);
  toast(msg, 'error', 6500);
  console.error(err);
}

/** Clipboard write with a fallback: the renderer runs from file:// with a tight CSP. */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok) throw new Error(t('toast.copyFailed'));
  return true;
}

function busy(key, value) {
  if (value === undefined) return !!state.busy[key];
  state.busy[key] = value;
  return value;
}

// ---------------------------------------------------------------- data
async function refreshInstances() {
  state.instances = (await call(api.instances.list())) || [];
  if (!state.activeId && state.instances.length) {
    state.activeId = state.instances[0].id;
    if (state.view === 'welcome') state.view = 'server';
  }
  if (state.activeId && !state.instances.some((i) => i.id === state.activeId)) {
    state.activeId = state.instances[0] ? state.instances[0].id : null;
  }
}

async function refreshStatuses() {
  const list = (await call(api.instances.statuses())) || [];
  for (const s of list) state.statuses[s.id] = s;
  return list;
}

async function loadAll() {
  await loadLanguage(state.settings.language || 'en');
  state.languages = (await call(api.i18n.list())) || [];
  state.providers = (await call(api.providers.list())) || [];
  state.license = (await call(api.license.status())) || { tier: 'free', features: [] };
  state.monetize = (await call(api.monetize.info())) || {};
  state.appInfo = (await call(api.app.info())) || {};
  await refreshInstances();
  await refreshStatuses();
  try { state.upsell = await call(api.monetize.suggest()); } catch { state.upsell = null; }
}

// ---------------------------------------------------------------- render
let renderQueued = false;
let renderForce = true;

/**
 * Coalesce renders. Deliberately NOT requestAnimationFrame: Chromium throttles
 * rAF to ~0 calls/s while the window is hidden, minimised or occluded, which
 * would freeze the whole UI until the user looked at it again.
 *
 * `force: false` marks a *background* update (status poll, server event). Those
 * must never take the DOM away from the user, so `paint` holds them back while a
 * field inside the region is focused. Anything the user triggered stays forced.
 */
function rerender({ force = true } = {}) {
  // a queued render is forced as soon as any of the queued requests was forced
  renderForce = renderQueued ? (renderForce || force) : force;
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const forced = renderForce;
    renderForce = true;
    try {
      render(forced);
    } catch (err) {
      console.error('render failed', err);
    }
  }, 16);
}

// ---- DOM painting ---------------------------------------------------------
// Assigning `innerHTML` on every status tick destroys whatever the user is doing
// in that region: the focused field is replaced (value from state, caret gone),
// an open <select> popup snaps shut because its node is detached, the console
// jumps back to the bottom. So a region is only touched when its markup really
// changed, and never while the user is typing in it.
function activeControlIn(root) {
  const a = document.activeElement;
  if (!root || !a || !root.contains(a)) return null;
  return a.matches('input, textarea, select') ? a : null;
}

function captureFocus(root) {
  const a = activeControlIn(root);
  if (!a) return null;
  let start = null;
  let end = null;
  try { start = a.selectionStart; end = a.selectionEnd; } catch { /* not a text control */ }
  return { id: a.id || null, prop: (a.dataset && a.dataset.prop) || null, start, end };
}

function restoreFocus(root, snap) {
  if (!snap) return;
  let el = snap.id ? document.getElementById(snap.id) : null;
  if (!el && snap.prop) el = root.querySelector(`[data-prop="${snap.prop}"]`);
  if (!el || !root.contains(el)) return;
  el.focus();
  if (snap.start != null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(snap.start, snap.end); } catch { /* ignore */ }
  }
}

/**
 * Free-text fields that are not bound to state (e.g. the player name box) keep
 * what the user typed across a repaint.
 */
function captureFieldValues(root) {
  const out = {};
  for (const el of root.querySelectorAll('input, textarea, select')) {
    if (!el.id) continue;
    if (el.dataset.prop || el.dataset.field || el.dataset.inst || el.dataset.tunnel) continue;
    out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function restoreFieldValues(root, values) {
  for (const [id, val] of Object.entries(values || {})) {
    const el = root.querySelector(`#${id}`);
    if (!el) continue;
    if (el.type === 'checkbox') { el.checked = val; continue; }
    if (!el.value && val) el.value = val;   // a value rendered from state always wins
  }
}

/** Replace a region's markup — only when it changed, and not while it is edited. */
function paint(root, html, force = true) {
  if (!root) return false;
  if (root.__paintedHtml === html) return false;
  if (activeControlIn(root) && !force) {
    root.__pendingHtml = html;
    return false;
  }
  const snap = captureFocus(root);
  const fields = captureFieldValues(root);
  root.innerHTML = html;
  root.__paintedHtml = html;
  root.__pendingHtml = null;
  restoreFieldValues(root, fields);
  restoreFocus(root, snap);
  return true;
}

/** Apply a background update that was held back while the user was editing. */
function flushPendingPaints() {
  for (const root of [$('#instance-list'), $('#upsell-slot'), $('#content')]) {
    if (!root || root.__pendingHtml == null) continue;
    const painted = paint(root, root.__pendingHtml, true);
    if (painted && root.id === 'content') afterContentPaint();
  }
}
document.addEventListener('focusout', () => setTimeout(flushPendingPaints, 0));

function render(force = true) {
  applyStaticI18n();
  $('#brand-version').textContent = state.appInfo.version ? `v${state.appInfo.version}` : '';
  const lb = $('#license-badge');
  lb.textContent = state.license.tier || 'free';
  lb.className = `badge ${state.license.tier !== 'free' ? 'paid' : ''}`;

  renderInstanceList(force);
  renderUpsell(force);
  renderLanguageSelect();
  renderBreadcrumb();
  renderContent(force);
}

function renderInstanceList(force = true) {
  const root = $('#instance-list');
  if (!state.instances.length) {
    paint(root, `<div class="empty">${esc(t('nav.noServers'))}</div>`, force);
    return;
  }
  const html = state.instances.map((i) => {
    const st = state.statuses[i.id] || {};
    const status = st.state || 'offline';
    const online = status === 'online' || status === 'starting';
    const players = online && st.players ? `${st.players.online}/${st.players.max}` : '';
    return `<button class="nav-item ${i.id === state.activeId && state.view === 'server' ? 'active' : ''}"
              data-action="open-instance" data-id="${esc(i.id)}">
        <span class="dot ${esc(status)}"></span>
        <span class="name">${esc(i.name)}</span>
        <span class="players">${esc(players)}</span>
      </button>`;
  }).join('');
  paint(root, html, force);
}

function renderLanguageSelect() {
  const sel = $('#language-select');
  const codes = state.languages.length ? state.languages.map((l) => l.code) : ['en', 'de'];
  const current = state.settings.language || 'en';
  if (sel.dataset.built !== codes.join(',')) {
    sel.innerHTML = codes.map((c) => `<option value="${esc(c)}">${esc(c.toUpperCase())}</option>`).join('');
    sel.dataset.built = codes.join(',');
  }
  sel.value = current;
}

function renderUpsell(force = true) {
  const slot = $('#upsell-slot');
  if (!state.upsell || state.settings.showUpsellCards === false) { paint(slot, '', force); return; }
  const u = state.upsell;
  paint(slot, `<div class="upsell">
      <span>★</span>
      <span><strong>${esc(t(`upsell.${u.feature}.headline`))}</strong>
      <span class="muted"> ${esc(t(`upsell.${u.feature}.body`))}</span></span>
      <button class="btn btn-sm btn-primary" data-action="upsell-open" data-feature="${esc(u.feature)}">${esc(t('upsell.cta'))}</button>
      <span class="x" data-action="upsell-dismiss" data-kind="${esc(u.feature)}">✕</span>
    </div>`, force);
}

function renderBreadcrumb() {
  const inst = state.instances.find((i) => i.id === state.activeId);
  const titles = {
    welcome: [t('welcome.title'), t('welcome.subtitle')],
    server: [inst ? inst.name : t('nav.servers'), inst ? `${inst.provider} · ${inst.mcVersion}${inst.loaderVersion ? ` · ${inst.loaderVersion}` : ''}` : ''],
    settings: [t('settings.title'), t('settings.subtitle')],
    runtimes: [t('runtimes.title'), t('runtimes.subtitle')],
    cloud: [t('cloud.title'), t('cloud.subtitle')],
    license: [t('license.title'), t('license.subtitle')]
  };
  const [title, sub] = titles[state.view] || ['MCServerSmith', ''];
  $('#view-title').textContent = title;
  $('#view-subtitle').textContent = sub;
}

function renderContent(force = true) {
  const el = $('#content');
  let html = '';
  if (state.view === 'welcome') html = viewWelcome();
  else if (state.view === 'server') html = viewServer();
  else if (state.view === 'settings') html = viewSettings();
  else if (state.view === 'runtimes') html = viewRuntimes();
  else if (state.view === 'cloud') html = viewCloud();
  else if (state.view === 'license') html = viewLicense();
  if (paint(el, html, force)) afterContentPaint();
}

/**
 * The console keeps its own append-only DOM (mountConsole), so it has to be told
 * when its skeleton was freshly painted. Without this it would either not render
 * at all or rebuild the whole log — scroll position included — every few seconds.
 */
function afterContentPaint() {
  if (state.view !== 'server') return;
  if (state.tab === 'console') mountConsole();
  if (state.tab === 'files') applyFilesFilter();
}

// ---------------------------------------------------------------- views
function viewWelcome() {
  const paid = state.license.tier !== 'free';
  return `<div class="hero">
    <h2>${esc(t('welcome.title'))}</h2>
    <p>${esc(t('welcome.subtitle'))}</p>
    <div class="row" style="justify-content:center">
      <button class="btn btn-primary" data-action="new-server">${esc(t('welcome.cta'))}</button>
      <button class="btn" data-action="goto" data-view="cloud">${esc(t('cloud.title'))}</button>
    </div>
  </div>
  <div class="grid cols-2" style="max-width:960px;margin:22px auto 0">
    <div class="card"><h3>${esc(t('welcome.f1.title'))}</h3><div class="muted">${esc(t('welcome.f1.body'))}</div></div>
    <div class="card"><h3>${esc(t('welcome.f2.title'))}</h3><div class="muted">${esc(t('welcome.f2.body'))}</div></div>
    <div class="card"><h3>${esc(t('welcome.f3.title'))}</h3><div class="muted">${esc(t('welcome.f3.body'))}</div></div>
    <div class="card"><h3>${esc(t('welcome.f4.title'))}</h3><div class="muted">${esc(t('welcome.f4.body'))}</div>
      ${paid ? '' : `<div style="margin-top:10px"><button class="btn btn-sm" data-action="goto" data-view="license">${esc(t('license.cta'))}</button></div>`}
    </div>
  </div>`;
}

function statePill(status) {
  return `<span class="pill ${esc(status)}">${esc(t(`state.${status}`))}</span>`;
}

function viewServer() {
  const inst = state.instances.find((i) => i.id === state.activeId);
  if (!inst) return `<div class="card">${esc(t('nav.noServers'))}</div>`;
  const st = state.statuses[inst.id] || {};
  const tabs = ['overview', 'console', 'players', 'addons', 'files', 'backups', 'network', 'config'];
  const tabLabels = {
    overview: 'tab.overview', console: 'tab.console', players: 'tab.players',
    addons: inst.kind === 'modded' ? 'tab.mods' : 'tab.plugins',
    files: 'tab.files',
    backups: 'tab.backups', network: 'tab.network', config: 'tab.config'
  };
  return `
    <div class="row between" style="margin-bottom:14px">
      <div class="row">
        ${tabs.map((tb) => `<button class="btn btn-sm ${tb === state.tab ? 'btn-primary' : 'btn-ghost'}"
            data-action="tab" data-tab="${tb}">${esc(t(tabLabels[tb]))}</button>`).join('')}
      </div>
      <div class="row">${serverActions(inst, st)}</div>
    </div>
    ${state.tab === 'overview' ? tabOverview(inst, st) : ''}
    ${state.tab === 'console' ? tabConsole(inst, st) : ''}
    ${state.tab === 'players' ? tabPlayers(inst, st) : ''}
    ${state.tab === 'addons' ? tabAddons(inst, st) : ''}
    ${state.tab === 'files' ? tabFiles(inst) : ''}
    ${state.tab === 'backups' ? tabBackups(inst, st) : ''}
    ${state.tab === 'network' ? tabNetwork(inst, st) : ''}
    ${state.tab === 'config' ? tabConfig(inst, st) : ''}`;
}

function serverActions(inst, st) {
  const status = st.state || 'offline';
  const installing = st.install || busy(`install:${inst.id}`);
  const running = status === 'online' || status === 'starting';
  if (installing) {
    return `<span class="muted small">${esc(t('install.inProgress'))}</span>`;
  }
  if (!inst.installed) {
    return `<button class="btn btn-primary btn-sm" data-action="install" data-id="${esc(inst.id)}">${esc(t('action.install'))}</button>`;
  }
  return `
    <button class="btn btn-sm btn-primary" data-action="start" data-id="${esc(inst.id)}" ${running ? 'disabled' : ''}>${esc(t('action.start'))}</button>
    <button class="btn btn-sm" data-action="restart" data-id="${esc(inst.id)}" ${running ? '' : 'disabled'}>${esc(t('action.restart'))}</button>
    <button class="btn btn-sm" data-action="stop" data-id="${esc(inst.id)}" ${running ? '' : 'disabled'}>${esc(t('action.stop'))}</button>
    <button class="btn btn-sm btn-danger" data-action="kill" data-id="${esc(inst.id)}" ${running ? '' : 'disabled'}>${esc(t('action.kill'))}</button>`;
}

function installBanner(inst, st) {
  const p = st.install;
  if (!p) return '';
  return `<div class="card">
    <h3>${esc(t('install.title'))}</h3>
    <div class="progress" style="margin:8px 0"><div style="width:${Math.max(2, Math.min(100, p.percent || 0))}%"></div></div>
    <div class="row between">
      <span class="mono small">${esc(p.phase || '')} · ${esc(p.message || '')}</span>
      <span class="muted small">${p.percent != null ? `${p.percent}%` : ''}</span>
    </div>
  </div>`;
}

function tabOverview(inst, st) {
  const m = st.metrics || {};
  const players = st.players || { online: 0, max: inst.maxPlayers };
  const memPct = inst.memoryMB ? Math.min(100, Math.round(((m.rssBytes || 0) / 1048576) / inst.memoryMB * 100)) : 0;
  const addr = (st.address && st.address.joinAddress) || '—';
  return `
  ${installBanner(inst, st)}
  ${!inst.eulaAccepted ? `<div class="hint-box warn">
      ${esc(t('eula.notice'))}
      <div style="margin-top:8px"><button class="btn btn-sm btn-primary" data-action="accept-eula" data-id="${esc(inst.id)}">${esc(t('eula.accept'))}</button>
      <button class="btn btn-sm" data-action="open-eula" data-id="${esc(inst.id)}">${esc(t('eula.read'))}</button></div>
    </div>` : ''}
  ${st.lastError ? `<div class="hint-box danger prewrap">${esc(st.lastError)}</div>` : ''}
  <div class="grid cols-4">
    <div class="stat"><div class="label">${esc(t('stat.status'))}</div>
      <div class="value">${statePill(st.state || 'offline')}</div>
      <div class="hint">${st.pid ? `pid ${st.pid}` : ''}</div></div>
    <div class="stat"><div class="label">${esc(t('stat.players'))}</div>
      <div class="value">${players.online}<span class="muted" style="font-size:14px">/${players.max}</span></div>
      <div class="hint">${players.source ? esc(players.source) : '—'}</div></div>
    <div class="stat"><div class="label">${esc(t('stat.uptime'))}</div>
      <div class="value">${esc(fmtDuration(st.uptimeMs))}</div>
      <div class="hint">${st.startedAt ? esc(new Date(st.startedAt).toLocaleTimeString()) : ''}</div></div>
    <div class="stat"><div class="label">${esc(t('stat.address'))}</div>
      <div class="value mono" style="font-size:14px;word-break:break-all">${esc(addr)}</div>
      <div class="hint">${esc(t('stat.port'))} ${inst.port}
        <button class="btn btn-sm btn-ghost" data-action="copy" data-text="${esc(addr)}">⧉</button></div></div>
  </div>
  <div class="grid cols-2" style="margin-top:14px">
    <div class="card">
      <h3>${esc(t('overview.resources'))}</h3>
      <div class="bar-row"><span style="width:54px">RAM</span>
        <span class="bar"><div style="width:${memPct}%"></div></span>
        <span class="mono">${esc(fmtBytes(m.rssBytes))} / ${inst.memoryMB} MB</span></div>
      <div class="bar-row" style="margin-top:8px"><span style="width:54px">CPU</span>
        <span class="bar"><div style="width:${Math.min(100, m.cpuPercent || 0)}%"></div></span>
        <span class="mono">${m.cpuPercent != null ? `${m.cpuPercent}%` : '—'}</span></div>
      ${st.tps ? `<div class="bar-row" style="margin-top:8px"><span style="width:54px">TPS</span>
        <span class="bar"><div style="width:${Math.min(100, (st.tps[0] / 20) * 100)}%"></div></span>
        <span class="mono">${st.tps.map((x) => x.toFixed(1)).join(', ')}</span></div>` : ''}
      <div class="row between" style="margin-top:12px">
        <span class="muted small">${esc(t('overview.worldSize'))}</span>
        <span class="mono small">${esc(fmtBytes(st.worldSizeBytes))}</span>
      </div>
      <div class="row between" style="margin-top:4px">
        <span class="muted small">${esc(t('overview.latency'))}</span>
        <span class="mono small">${st.server && st.server.latencyMs != null ? `${st.server.latencyMs} ms` : '—'}</span>
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('overview.details'))}</h3>
      <table>
        <tr><td>${esc(t('overview.serverType'))}</td><td>${esc(inst.provider)} ${esc(inst.mcVersion)}${inst.loaderVersion ? ` · ${esc(inst.loaderVersion)}` : ''}</td></tr>
        <tr><td>Java</td><td>${esc(String(st.jvm ? st.jvm.javaFeature : inst.javaFeature || '—'))} ${esc((st.jvm && st.jvm.javaKind) || '')}</td></tr>
        <tr><td>MOTD</td><td>${esc((st.server && st.server.motd) || inst.motd)}</td></tr>
        <tr><td>${esc(t('overview.starts'))}</td><td>${esc(String((inst.stats && inst.stats.totalStarts) || 0))}</td></tr>
        <tr><td>${esc(t('overview.autoRestart'))}</td><td>${inst.autoRestart ? '✓' : '—'}</td></tr>
        <tr><td>${esc(t('overview.lastBackup'))}</td><td>${esc(inst.backup && inst.backup.lastRunAt ? fmtTime(inst.backup.lastRunAt) : '—')}</td></tr>
      </table>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm" data-action="backup-now" data-id="${esc(inst.id)}">${esc(t('action.backupNow'))}</button>
        <button class="btn btn-sm" data-action="open-folder" data-id="${esc(inst.id)}">${esc(t('action.openFolder'))}</button>
        <button class="btn btn-sm btn-danger" data-action="delete-instance" data-id="${esc(inst.id)}">${esc(t('action.delete'))}</button>
      </div>
    </div>
  </div>`;
}

function tabConsole(inst) {
  return `<div class="card">
    <div class="row between" style="margin-bottom:8px">
      <div class="row">
        <input type="text" id="console-filter" placeholder="${esc(t('console.filter'))}" value="${esc(state.consoleFilter || '')}" style="width:230px" />
        <label class="switch"><input type="checkbox" id="console-autoscroll" ${state.autoScroll ? 'checked' : ''} /> ${esc(t('console.autoscroll'))}</label>
      </div>
      <div class="row">
        <button class="btn btn-sm" data-action="console-clear">${esc(t('console.clear'))}</button>
      </div>
    </div>
    <div class="console" id="console-output"></div>
    <div class="console-input">
      <input type="text" id="console-cmd" placeholder="${esc(t('console.placeholder'))}" autocomplete="off" />
      <button class="btn btn-primary" data-action="console-send">${esc(t('console.send'))}</button>
    </div>
    <div class="muted small" style="margin-top:8px">${esc(t('console.hint'))}</div>
  </div>`;
}

function tabPlayers(inst, st) {
  const names = (st.players && st.players.names) || [];
  const online = (st.players && st.players.online) || 0;
  return `<div class="grid cols-2">
    <div class="card">
      <h3>${esc(t('players.online'))} (${online})</h3>
      ${names.length ? `<table><tbody>${names.map((n) => `<tr><td>${esc(n)}</td>
        <td class="actions">
          <button class="btn btn-sm btn-ghost" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="op ${esc(n)}">op</button>
          <button class="btn btn-sm btn-ghost" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="kick ${esc(n)}">kick</button>
          <button class="btn btn-sm btn-ghost" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="ban ${esc(n)}">ban</button>
        </td></tr>`).join('')}</tbody></table>`
      : `<div class="muted small">${esc(t('players.none'))}</div>`}
      <div class="muted small" style="margin-top:10px">${esc(t('players.hint'))}</div>
    </div>
    <div class="card">
      <h3>${esc(t('players.actions'))}</h3>
      <div class="row">
        <input type="text" id="player-name" placeholder="${esc(t('players.name'))}" style="width:180px" />
        <button class="btn btn-sm" data-action="player-act" data-id="${esc(inst.id)}" data-cmd="whitelist add">whitelist +</button>
        <button class="btn btn-sm" data-action="player-act" data-id="${esc(inst.id)}" data-cmd="whitelist remove">whitelist −</button>
        <button class="btn btn-sm" data-action="player-act" data-id="${esc(inst.id)}" data-cmd="op">op</button>
        <button class="btn btn-sm" data-action="player-act" data-id="${esc(inst.id)}" data-cmd="deop">deop</button>
        <button class="btn btn-sm" data-action="player-act" data-id="${esc(inst.id)}" data-cmd="pardon">pardon</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="whitelist on">whitelist on</button>
        <button class="btn btn-sm" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="whitelist off">whitelist off</button>
        <button class="btn btn-sm" data-action="rcon" data-id="${esc(inst.id)}" data-cmd="save-all">save-all</button>
      </div>
    </div>
  </div>`;
}

function tabAddons(inst) {
  const key = `addons:${inst.id}`;
  const c = state.addons && state.addons[key] ? state.addons[key] : { source: 'modrinth', query: '', results: [], installed: null };
  return `<div class="card">
    <h3>${inst.kind === 'modded' ? esc(t('tab.mods')) : esc(t('tab.plugins'))}</h3>
    <div class="row" style="margin-bottom:10px">
      <select class="select" id="addon-source" style="width:150px">
        <option value="modrinth" ${c.source === 'modrinth' ? 'selected' : ''}>Modrinth</option>
        <option value="hangar" ${c.source === 'hangar' ? 'selected' : ''}>Hangar (PaperMC)</option>
      </select>
      <input type="text" id="addon-query" placeholder="${esc(t('addons.search'))}" style="flex:1" value="${esc(c.query)}" />
      <button class="btn btn-primary" data-action="addon-search" data-id="${esc(inst.id)}">${esc(t('addons.searchBtn'))}</button>
    </div>
    <div class="muted small" style="margin-bottom:10px">${esc(t('addons.hint', { v: inst.mcVersion }))}</div>
    ${(c.results || []).length ? `<div class="scroll-y"><table><tbody>
      ${c.results.map((r) => `<tr>
        <td style="width:34px">${r.icon ? `<img src="${esc(r.icon)}" width="26" height="26" style="border-radius:6px" />` : ''}</td>
        <td><strong>${esc(r.name)}</strong><div class="muted small">${esc((r.description || '').slice(0, 140))}</div></td>
        <td class="muted small" style="width:90px">${esc((r.downloads || 0).toLocaleString())} ⤓</td>
        <td class="actions">
          <button class="btn btn-sm" data-action="addon-versions" data-id="${esc(inst.id)}" data-source="${esc(r.source)}" data-project="${esc(r.id)}">${esc(t('addons.versions'))}</button>
          ${r.pageUrl ? `<button class="btn btn-sm btn-ghost" data-action="open-external" data-url="${esc(r.pageUrl)}">↗</button>` : ''}
        </td></tr>`).join('')}
    </tbody></table></div>` : `<div class="muted small">${esc(t('addons.noResults'))}</div>`}
    ${c.picked ? `<div class="hint-box" style="margin-top:14px">
      <strong>${esc(c.picked.name || '')}</strong>
      <table style="margin-top:8px"><tbody>
        ${(c.picked.versions || []).slice(0, 12).map((v) => `<tr>
          <td>${esc(v.name)} <span class="muted small">${esc(v.channel || v.versionType || '')}</span></td>
          <td class="muted small">${esc(fmtBytes(v.size))}</td>
          <td class="actions"><button class="btn btn-sm btn-primary" data-action="addon-install" data-id="${esc(inst.id)}"
            data-url="${esc(v.downloadUrl)}" data-file="${esc(v.filename)}"
            data-hash="${esc((v.hashes && (v.hashes.sha256 || v.hashes.sha512 || v.hashes.sha1)) || '')}">${esc(t('addons.install'))}</button></td>
        </tr>`).join('')}
      </tbody></table>
    </div>` : ''}
  </div>
  ${c.installed ? `<div class="card">
    <h3>${esc(t('addons.installed'))} — ${esc(c.installed.folder)}/</h3>
    ${c.installed.files.length ? `<table><tbody>${c.installed.files.map((f) => `<tr>
      <td>${esc(f.name)} ${f.disabled ? '<span class="muted small">(disabled)</span>' : ''}</td>
      <td class="muted small">${esc(fmtBytes(f.bytes))}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" data-action="addon-toggle" data-id="${esc(inst.id)}" data-file="${esc(f.name)}">${f.disabled ? 'enable' : 'disable'}</button>
        <button class="btn btn-sm btn-danger" data-action="addon-remove" data-id="${esc(inst.id)}" data-file="${esc(f.name)}">✕</button>
      </td></tr>`).join('')}</tbody></table>`
    : `<div class="muted small">${esc(t('addons.none'))}</div>`}
  </div>` : ''}`;
}

function tabBackups(inst) {
  const key = `backups:${inst.id}`;
  const list = (state.backups && state.backups[key]) || [];
  const b = inst.backup || {};
  return `<div class="card">
    <div class="row between">
      <h3>${esc(t('backups.title'))}</h3>
      <div class="row">
        <button class="btn btn-sm btn-primary" data-action="backup-now" data-id="${esc(inst.id)}">${esc(t('backups.create'))}</button>
        <button class="btn btn-sm" data-action="backup-refresh" data-id="${esc(inst.id)}">↻</button>
      </div>
    </div>
    ${list.length ? `<table><tbody>${list.map((x) => `<tr>
        <td class="mono small">${esc(x.name)}</td>
        <td class="muted small">${esc(fmtTime(x.createdAt))}</td>
        <td class="muted small">${esc(fmtBytes(x.bytes))}</td>
        <td class="actions">
          <button class="btn btn-sm" data-action="backup-restore" data-id="${esc(inst.id)}" data-name="${esc(x.name)}">${esc(t('backups.restore'))}</button>
          <button class="btn btn-sm btn-danger" data-action="backup-delete" data-id="${esc(inst.id)}" data-name="${esc(x.name)}">✕</button>
        </td></tr>`).join('')}</tbody></table>`
      : `<div class="muted small">${esc(t('backups.none'))}</div>`}
  </div>
  <div class="card">
    <h3>${esc(t('backups.auto'))}</h3>
    <label class="check"><input type="checkbox" data-action="set-backup-enabled" data-id="${esc(inst.id)}" ${b.enabled ? 'checked' : ''} />
      <span>${esc(t('backups.autoEnabled'))}</span></label>
    <div class="grid cols-2">
      <label class="field"><span>${esc(t('backups.interval'))}</span>
        <input type="number" min="1" max="72" value="${b.intervalHours || 6}" data-action="set-backup-interval" data-id="${esc(inst.id)}" /></label>
      <label class="field"><span>${esc(t('backups.keep'))}</span>
        <input type="number" min="1" max="50" value="${b.keep || 7}" data-action="set-backup-keep" data-id="${esc(inst.id)}" /></label>
    </div>
    ${state.license.tier === 'free' ? `<div class="hint-box gold">${esc(t('backups.gated'))}
      <button class="btn btn-sm btn-primary" style="margin-left:8px" data-action="goto" data-view="license">${esc(t('license.cta'))}</button></div>` : ''}
  </div>`;
}

function tabNetwork(inst, st) {
  const t2 = inst.tunnel || { provider: 'none' };
  const addr = st.address || {};
  const running = (state.tunnelStatus && state.tunnelStatus[inst.id]) || {};
  return `<div class="grid cols-2">
    <div class="card">
      <h3>${esc(t('network.address'))}</h3>
      <table>
        <tr><td>${esc(t('network.local'))}</td><td class="mono small">${addr.local && addr.local.length ? addr.local.map((l) => `${esc(l.address)}:${inst.port}`).join('<br>') : '—'}</td></tr>
        <tr><td>${esc(t('network.public'))}</td><td class="mono small">${addr.publicIp ? `${esc(addr.publicIp)}:${inst.port}` : '—'}</td></tr>
        <tr><td>${esc(t('network.join'))}</td><td class="mono small">${esc(addr.joinAddress || '—')}
          <button class="btn btn-sm btn-ghost" data-action="copy" data-text="${esc(addr.joinAddress || '')}">⧉</button></td></tr>
      </table>
      <div class="hint-box">${esc(t('network.explain'))}</div>
      <div class="row">
        <button class="btn btn-sm" data-action="upnp" data-id="${esc(inst.id)}">${esc(t('network.upnp'))}</button>
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('network.tunnel'))}</h3>
      <label class="field"><span>${esc(t('network.provider'))}</span>
        <select id="tunnel-provider" class="select" data-action="tunnel-provider">
          ${['none', 'frp', 'playit', 'custom'].map((p) => `<option value="${p}" ${t2.provider === p ? 'selected' : ''}>${esc(t(`tunnel.${p}`))}</option>`).join('')}
        </select></label>
      <div id="tunnel-fields">
        ${t2.provider === 'frp' ? `
          <label class="field"><span>${esc(t('tunnel.serverAddr'))}</span><input type="text" value="${esc(t2.serverAddr || '')}" data-tunnel="serverAddr" /></label>
          <div class="grid cols-2">
            <label class="field"><span>${esc(t('tunnel.serverPort'))}</span><input type="number" value="${esc(t2.serverPort || 7000)}" data-tunnel="serverPort" /></label>
            <label class="field"><span>${esc(t('tunnel.remotePort'))}</span><input type="number" value="${esc(t2.remotePort || 25566)}" data-tunnel="remotePort" /></label>
          </div>
          <label class="field"><span>${esc(t('tunnel.token'))}</span><input type="password" value="${esc(t2.token || '')}" data-tunnel="token" /></label>
          <label class="field"><span>${esc(t('tunnel.publicHost'))}</span><input type="text" value="${esc(t2.publicHost || '')}" data-tunnel="publicHost" placeholder="play.example.com" /></label>
          <label class="check"><input type="checkbox" ${t2.proxyProtocol ? 'checked' : ''} data-tunnel="proxyProtocol" />
            <span>${esc(t('tunnel.proxyProtocol'))}</span></label>` : ''}
        ${t2.provider === 'playit' ? `
          <label class="field"><span>${esc(t('tunnel.playitPath'))}</span><input type="text" value="${esc(t2.playitPath || '')}" data-tunnel="playitPath" /></label>
          <button class="btn btn-sm" data-action="pick-playit">…</button>` : ''}
        ${t2.provider === 'custom' ? `
          <label class="field"><span>${esc(t('tunnel.customCommand'))}</span><input type="text" value="${esc(t2.customCommand || '')}" data-tunnel="customCommand" /></label>
          <label class="field"><span>${esc(t('tunnel.customRegex'))}</span><input type="text" value="${esc(t2.customRegex || '')}" data-tunnel="customRegex" /></label>` : ''}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm" data-action="tunnel-save" data-id="${esc(inst.id)}">${esc(t('action.save'))}</button>
        <button class="btn btn-sm btn-primary" data-action="tunnel-start" data-id="${esc(inst.id)}">${esc(t('network.tunnelStart'))}</button>
        <button class="btn btn-sm" data-action="tunnel-stop" data-id="${esc(inst.id)}">${esc(t('network.tunnelStop'))}</button>
      </div>
      ${running.running ? `<div class="hint-box" style="margin-top:10px">
        <strong>${esc(running.provider)}</strong> — ${esc(running.address || t('network.tunnelStarting'))}
        ${running.tail ? `<pre class="mono small" style="margin:8px 0 0;white-space:pre-wrap">${esc(running.tail.join('\n'))}</pre>` : ''}</div>` : ''}
      ${state.license.tier === 'free' ? `<div class="hint-box gold">${esc(t('network.gated'))}
        <button class="btn btn-sm btn-primary" style="margin-left:8px" data-action="goto" data-view="license">${esc(t('license.cta'))}</button></div>` : ''}
      <div class="hint-box warn">${esc(t('network.ipWarning'))}</div>
    </div>
  </div>`;
}

function tabConfig(inst) {
  const c = (state.props && state.props[inst.id]) || { values: {} };
  const v = c.values || {};
  const fields = [
    ['motd', 'text'], ['server-port', 'number'], ['max-players', 'number'],
    ['difficulty', 'select:peaceful,easy,normal,hard'], ['gamemode', 'select:survival,creative,adventure,spectator'],
    ['view-distance', 'number'], ['simulation-distance', 'number'], ['online-mode', 'bool'],
    ['pvp', 'bool'], ['white-list', 'bool'], ['spawn-protection', 'number'],
    ['rcon.port', 'number'], ['rcon.password', 'text'], ['level-name', 'text']
  ];
  return `<div class="grid cols-2">
    <div class="card">
      <h3>${esc(t('config.title'))}</h3>
      <div class="muted small" style="margin-bottom:12px">${esc(t('config.hint'))}</div>
      ${fields.map(([key, type]) => {
        const val = v[key] === undefined ? '' : v[key];
        if (type === 'bool') {
          return `<label class="check"><input type="checkbox" data-prop="${esc(key)}" ${val === 'true' ? 'checked' : ''} /><span class="mono">${esc(key)}</span></label>`;
        }
        if (type.startsWith('select')) {
          const opts = type.split(':')[1].split(',');
          return `<label class="field"><span class="mono">${esc(key)}</span>
            <select class="select" data-prop="${esc(key)}">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
        }
        return `<label class="field"><span class="mono">${esc(key)}</span>
          <input type="${type}" value="${esc(val)}" data-prop="${esc(key)}" /></label>`;
      }).join('')}
      <button class="btn btn-primary" data-action="save-props" data-id="${esc(inst.id)}">${esc(t('action.save'))}</button>
    </div>
    <div class="card">
      <h3>${esc(t('config.launcher'))}</h3>
      <label class="field"><span>${esc(t('config.memory'))}</span>
        <input type="number" min="512" step="512" value="${inst.memoryMB}" data-inst="${esc(inst.id)}" data-field="memoryMB" /></label>
      <label class="field"><span>${esc(t('config.maxPlayers'))}</span>
        <input type="number" min="1" max="500" value="${inst.maxPlayers}" data-inst="${esc(inst.id)}" data-field="maxPlayers" /></label>
      <label class="check"><input type="checkbox" ${inst.autoRestart ? 'checked' : ''} data-inst="${esc(inst.id)}" data-field="autoRestart" />
        <span>${esc(t('config.autoRestart'))}</span></label>
      <label class="check"><input type="checkbox" ${inst.scheduleRestarts ? 'checked' : ''} data-inst="${esc(inst.id)}" data-field="scheduleRestarts" />
        <span>${esc(t('config.schedule'))}</span></label>
      <label class="field"><span>${esc(t('config.scheduleTime'))}</span>
        <input type="text" placeholder="04:00" value="${esc(inst.scheduledRestart || '')}" data-inst="${esc(inst.id)}" data-field="scheduledRestart" /></label>
      <button class="btn btn-primary" data-action="save-instance" data-id="${esc(inst.id)}">${esc(t('action.save'))}</button>
      <button class="btn" data-action="reinstall" data-id="${esc(inst.id)}">${esc(t('config.reinstall'))}</button>
      <div class="hint-box warn" style="margin-top:12px">${esc(t('config.reinstallHint'))}</div>
    </div>
  </div>`;
}

function viewSettings() {
  const s = state.settings;
  return `<div class="grid cols-2">
    <div class="card">
      <h3>${esc(t('settings.general'))}</h3>
      <label class="field"><span>${esc(t('settings.language'))}</span>
        <select class="select" id="setting-language" data-action="setting-language">
          ${(state.languages.length ? state.languages : [{ code: 'en', name: 'English' }]).map((l) => `<option value="${esc(l.code)}" ${s.language === l.code ? 'selected' : ''}>${esc(l.name || l.code)}</option>`).join('')}
        </select></label>
      <label class="check"><input type="checkbox" data-setting="closeToTray" ${s.closeToTray ? 'checked' : ''} /><span>${esc(t('settings.closeToTray'))}</span></label>
      <label class="check"><input type="checkbox" data-setting="autoPortForward" ${s.autoPortForward ? 'checked' : ''} /><span>${esc(t('settings.autoPortForward'))}</span></label>
      <label class="check"><input type="checkbox" data-setting="showUpsellCards" ${s.showUpsellCards ? 'checked' : ''} /><span>${esc(t('settings.showUpsell'))}</span></label>
      <label class="check"><input type="checkbox" data-setting="showSupporterNudge" ${s.showSupporterNudge ? 'checked' : ''} /><span>${esc(t('settings.showNudge'))}</span></label>
      <label class="check"><input type="checkbox" data-setting="autoUpdate" ${s.autoUpdate ? 'checked' : ''} /><span>${esc(t('settings.autoUpdate'))}</span></label>
      <label class="check"><input type="checkbox" data-setting="showPublicIp" ${s.showPublicIp ? 'checked' : ''} /><span>${esc(t('settings.showPublicIp'))}</span></label>
      <p class="muted small" style="margin-top:10px">${esc(t('settings.privacyNote'))}</p>
    </div>
    <div class="card">
      <h3>${esc(t('settings.newDefaults'))}</h3>
      <label class="field"><span>${esc(t('settings.defaultProvider'))}</span>
        <select class="select" data-setting="defaultProvider">
          ${state.providers.map((p) => `<option value="${esc(p.id)}" ${s.defaultProvider === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select></label>
      <label class="field"><span>${esc(t('settings.defaultMemory'))}</span>
        <input type="number" min="512" step="512" value="${s.defaultMemoryMB}" data-setting="defaultMemoryMB" /></label>
      <h4>${esc(t('settings.data'))}</h4>
      <div class="mono small prewrap">${esc(state.appInfo.dataRoot || '')}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm" data-action="open-data">${esc(t('settings.openData'))}</button>
        <button class="btn btn-sm" data-action="open-log">${esc(t('settings.openLog'))}</button>
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('settings.translations'))}</h3>
      <div class="muted small">${esc(t('settings.translationsHint'))}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm" data-action="i18n-export">${esc(t('settings.exportTemplate'))}</button>
        <button class="btn btn-sm" data-action="i18n-import">${esc(t('settings.importTranslation'))}</button>
        <button class="btn btn-sm btn-ghost" data-action="open-locales">${esc(t('settings.openFolder'))}</button>
      </div>
      <h4>${esc(t('settings.loadedLangs'))}</h4>
      <table><tbody>${state.languages.map((l) => `<tr><td>${esc(l.name || l.code)}</td>
        <td class="muted small">${esc(l.source)}</td><td class="mono small">${esc(l.code)}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="card">
      <h3>${esc(t('settings.about'))}</h3>
      <table>
        <tr><td>${esc(t('settings.version'))}</td><td>${esc(state.appInfo.version || '')}</td></tr>
        <tr><td>Electron</td><td>${esc(state.appInfo.electron || '')}</td></tr>
        <tr><td>Node</td><td>${esc(state.appInfo.node || '')}</td></tr>
        <tr><td>${esc(t('settings.platform'))}</td><td>${esc(`${state.appInfo.platform}/${state.appInfo.arch}`)}</td></tr>
        <tr><td>git / tar</td><td>${state.appInfo.capabilities ? `${state.appInfo.capabilities.git ? '✓' : '✗'} / ${state.appInfo.capabilities.tar ? '✓' : '✗'}` : ''}</td></tr>
        <tr><td>${esc(t('settings.madeBy'))}</td><td>Leonhard Yvon</td></tr>
        <tr><td>${esc(t('settings.contact'))}</td><td><a href="#" data-action="open-external" data-url="mailto:leonhardyvon@gmx.net">leonhardyvon@gmx.net</a></td></tr>
        <tr><td>${esc(t('settings.license'))}</td><td>MIT © 2026 Leonhard Yvon</td></tr>
      </table>
      <p class="muted small" style="margin-top:12px;font-weight:600">${esc(t('settings.disclaimer'))}</p>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm" data-action="open-diagnostics">${esc(t('settings.diagnostics'))}</button>
        <button class="btn btn-sm" data-action="open-app-log">${esc(t('settings.openAppLog'))}</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------- files

function humanSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function humanDate(ms) {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

function currentFilesRel() {
  const data = state.files[state.activeId];
  return (data && data.path) || '';
}

async function refreshFiles(rel) {
  const inst = state.instances.find((i) => i.id === state.activeId);
  if (!inst) return;
  busy('files', true);
  try {
    if (state.settings.filesAdvanced === true) {
      const target = rel === undefined ? currentFilesRel() : rel;
      const data = await call(api.files.list(inst.id, target || ''));
      state.files[inst.id] = { path: data.path, parent: data.parent, entries: data.entries || [] };
    } else {
      const data = await call(api.files.simple(inst.id));
      state.files[inst.id] = { path: '', parent: null, rows: data.rows || [] };
    }
  } catch (err) {
    notifyError(err);
  } finally {
    busy('files', false);
  }
  rerender();
}

function tabFiles(inst) {
  const advanced = state.settings.filesAdvanced === true;
  const data = state.files[inst.id] || {};
  const rel = data.path || '';
  const sort = state.filesSort || { key: 'name', dir: 1 };
  const dirSign = sort.dir === -1 ? -1 : 1;

  const rows = advanced
    ? (data.entries || []).map((e) => ({
        label: e.name, rel: (rel ? `${rel}/` : '') + e.name, dir: e.dir, size: e.size, mtime: e.mtime
      }))
    : (data.rows || []).filter((r) => r.exists).map((r) => ({
        label: r.key.startsWith('file.') ? r.key.slice(5) : t(`files.${r.key}`),
        rel: r.rel, dir: r.dir, size: r.size, mtime: null
      }));

  // folders first, then the selected column — the way a file manager sorts
  rows.sort((a, b) => {
    if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1;
    let r;
    if (sort.key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (sort.key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
    else r = String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' });
    return r * dirSign;
  });

  const crumbs = [];
  if (advanced) {
    crumbs.push(`<a href="#" data-action="files-nav" data-rel="">${esc(inst.name)}</a>`);
    const parts = rel.split('/').filter(Boolean);
    parts.forEach((part, i) => {
      const target = parts.slice(0, i + 1).join('/');
      crumbs.push(`<span class="muted">/</span><a href="#" data-action="files-nav" data-rel="${esc(target)}">${esc(part)}</a>`);
    });
  }

  const head = (key, label) => `<th class="sortable ${sort.key === key ? 'sorted' : ''}" data-action="files-sort" data-sort="${key}">${esc(label)}<span class="sort-mark">${sort.key === key ? (dirSign > 0 ? '▲' : '▼') : ''}</span></th>`;

  const rowHtml = (r) => `<tr class="file-row" data-rel="${esc(r.rel)}" data-name="${esc(r.label)}" data-dir="${r.dir ? '1' : '0'}">
    <td class="fname"><button class="link" data-action="${r.dir ? 'files-nav' : 'files-open'}" data-rel="${esc(r.rel)}">
        <span class="ico">${r.dir ? '📁' : '📄'}</span> ${esc(r.label)}</button>
      ${advanced ? '' : `<div class="muted small mono">${esc(r.rel)}</div>`}</td>
    <td class="mono small">${r.dir ? '' : esc(humanSize(r.size))}</td>
    <td class="muted small">${esc(humanDate(r.mtime))}</td>
    <td class="actions">
      <button class="btn btn-sm btn-ghost" data-action="files-menu" data-rel="${esc(r.rel)}" title="${esc(t('files.more'))}">⋯</button>
      ${state.filesMenu === r.rel ? filesMenu(r) : ''}
    </td></tr>`;

  const body = rows.length
    ? `<table class="files"><thead><tr>${head('name', t('files.name'))}${head('size', t('files.size'))}${head('mtime', t('files.modified'))}<th></th></tr></thead>
         <tbody>${rows.map(rowHtml).join('')}</tbody></table>
       <div id="files-nomatch" class="muted small" style="display:none;margin-top:8px">${esc(t('files.noMatch'))}</div>`
    : `<p class="muted">${esc(t('files.empty'))}</p>`;

  return `
    <div class="card">
      <div class="row between" style="margin-bottom:12px">
        <div class="row">
          <button class="btn btn-sm ${advanced ? 'btn-ghost' : 'btn-primary'}" data-action="files-mode" data-mode="simple">${esc(t('files.simple'))}</button>
          <button class="btn btn-sm ${advanced ? 'btn-primary' : 'btn-ghost'}" data-action="files-mode" data-mode="advanced">${esc(t('files.advanced'))}</button>
        </div>
        <div class="row">
          <input type="text" id="files-filter" placeholder="${esc(t('files.filter'))}" value="${esc(state.filesFilter || '')}" style="width:170px" />
          <button class="btn btn-sm" data-action="files-mkdir">${esc(t('files.newFolder'))}</button>
          <button class="btn btn-sm" data-action="files-import">${esc(t('files.addFiles'))}</button>
          <button class="btn btn-sm btn-ghost" data-action="files-refresh">${esc(t('files.refresh'))}</button>
          <button class="btn btn-sm btn-ghost" data-action="files-reveal" data-rel="${esc(rel)}">${esc(t('files.openFolder'))}</button>
        </div>
      </div>
      ${advanced ? `<div class="row small" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">
          <button class="btn btn-sm btn-ghost" data-action="files-up" ${rel ? '' : 'disabled'}>↑</button>
          ${crumbs.join(' ')}
        </div>` : `<p class="muted small" style="margin-bottom:10px">${esc(t('files.simpleHint'))}</p>`}
      ${busy('files') ? `<p class="muted">${esc(t('common.loading'))}</p>` : body}
    </div>`;
}

/** Per-row overflow menu (replaces the two always-visible buttons per row). */
function filesMenu(r) {
  const item = (action, label, extra = '') =>
    `<button class="menu-item" data-action="${action}" data-rel="${esc(r.rel)}" data-name="${esc(r.label)}" ${extra}>${esc(label)}</button>`;
  return `<div class="menu">
      ${item(r.dir ? 'files-nav' : 'files-open', t('files.open'))}
      ${r.dir ? item('files-import', t('files.addHere')) : ''}
      <div class="menu-sep"></div>
      ${item('files-rename', t('files.rename'))}
      ${item('files-delete', t('files.delete'))}
      <div class="menu-sep"></div>
      ${item('files-reveal', t('files.openFolder'))}
      ${item('files-copy-path', t('files.copyPath'))}
    </div>`;
}

/** Hides non-matching rows in place, so typing in the filter never re-renders. */
function applyFilesFilter() {
  const q = String(state.filesFilter || '').toLowerCase();
  const rows = $$('tr.file-row', $('#content'));
  let visible = 0;
  for (const tr of rows) {
    const hit = !q || String(tr.dataset.name || '').toLowerCase().includes(q);
    tr.style.display = hit ? '' : 'none';
    if (hit) visible += 1;
  }
  const note = $('#files-nomatch');
  if (note) note.style.display = (visible || !rows.length) ? 'none' : '';
  return visible;
}

function viewRuntimes() {
  const list = state.java || [];
  return `<div class="card">
    <h3>${esc(t('runtimes.title'))}</h3>
    <div class="muted small" style="margin-bottom:12px">${esc(t('runtimes.hint'))}</div>
    ${list.length ? `<table><tbody>${list.map((j) => `<tr>
      <td>Java ${esc(String(j.feature))}</td><td class="muted small">${esc(j.kind)}</td>
      <td class="mono small">${esc(j.javaPath)}</td></tr>`).join('')}</tbody></table>`
      : `<div class="muted small">${esc(t('runtimes.none'))}</div>`}
    <div class="row" style="margin-top:14px">
      ${[8, 17, 21, 25].map((f) => `<button class="btn btn-sm" data-action="provision-java" data-feature="${f}">+ Java ${f}</button>`).join('')}
      <button class="btn btn-sm btn-ghost" data-action="refresh-java">↻</button>
    </div>
  </div>`;
}

function viewCloud() {
  const m = state.monetize || { hosters: [] };
  return `<div class="card">
    <h3>${esc(t('cloud.title'))}</h3>
    <div class="muted">${esc(t('cloud.intro'))}</div>
  </div>
  <div class="grid cols-2">
    ${(m.hosters || []).map((h) => `<div class="card hoster">
      <div class="row between"><h3 style="margin:0">${esc(h.name)}</h3>${h.highlight ? '<span class="badge paid">' + esc(t('cloud.recommended')) + '</span>' : ''}</div>
      <div class="price">${esc(h.priceFrom || '')}</div>
      <div class="muted small">${esc(h.spec || '')}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-sm btn-primary" data-action="open-external" data-url="${esc(h.openUrl)}">${esc(t('cloud.open'))}</button>
        ${h.isAffiliate ? `<span class="badge">affiliate</span>` : ''}
      </div>
      <div class="muted small" style="margin-top:8px">${esc(t('cloud.howto'))}</div>
    </div>`).join('')}
  </div>
  <div class="card">
    <h3>${esc(t('cloud.selfHost'))}</h3>
    <div class="muted small">${esc(t('cloud.selfHostBody'))}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-sm" data-action="open-external" data-url="https://www.hetzner.com/cloud">Hetzner Cloud ↗</button>
      <button class="btn btn-sm" data-action="open-external" data-url="https://github.com/fatedier/frp/releases">frp releases ↗</button>
    </div>
  </div>`;
}

function viewLicense() {
  const lic = state.license || {};
  const tiers = [
    { id: 'free', name: 'Free', items: ['license.free.1', 'license.free.2', 'license.free.3'] },
    { id: 'supporter', name: t('license.supporter'), items: ['license.pro.1', 'license.pro.2', 'license.pro.3', 'license.pro.4', 'license.pro.5'] }
  ];
  return `<div class="grid cols-2">
    <div class="card">
      <h3>${esc(t('license.current'))}</h3>
      <div class="row"><span class="pill ${lic.tier !== 'free' ? 'online' : 'offline'}">${esc(lic.label || lic.tier)}</span>
      ${lic.devMode ? '<span class="badge">dev mode</span>' : ''}</div>
      ${lic.keys && lic.keys.length ? `<table style="margin-top:12px"><tbody>${lic.keys.map((k) => `<tr>
        <td class="mono small">${esc(k.preview)}</td>
        <td>${k.valid ? '✓' : `<span class="muted">${esc(k.reason || 'invalid')}</span>`}</td>
        <td class="muted small">${esc(k.name || k.label || '')}</td>
        <td class="muted small">${k.expires ? esc(fmtTime(k.expires)) : esc(t('license.never'))}</td>
        <td class="actions"><button class="btn btn-sm btn-danger" data-action="license-remove" data-key="${esc(k.preview)}">✕</button></td>
      </tr>`).join('')}</tbody></table>` : ''}
      <h4>${esc(t('license.activate'))}</h4>
      <div class="row">
        <input type="text" id="license-key" placeholder="MCSS1-…" style="flex:1" />
        <button class="btn btn-primary" data-action="license-activate">${esc(t('license.activateBtn'))}</button>
      </div>
      <div class="muted small" style="margin-top:8px">${esc(t('license.offlineHint'))}</div>
    </div>
    <div class="card">
      <h3>${esc(t('license.tiers'))}</h3>
      ${tiers.map((tier) => `<div style="margin-bottom:14px">
        <div class="row between"><strong>${esc(tier.name)}</strong>
          ${tier.id === 'supporter' ? `<span class="muted small">${esc(state.monetize && state.monetize.supporter ? `${state.monetize.supporter.price} ${state.monetize.currency || 'EUR'}` : '')}</span>` : ''}</div>
        <ul class="muted small" style="margin:6px 0 0 16px">${tier.items.map((k) => `<li>${esc(t(k))}</li>`).join('')}</ul>
      </div>`).join('')}
      <div class="row">
        ${state.monetize && state.monetize.supporter && state.monetize.supporter.checkoutUrl
          ? `<button class="btn btn-primary" data-action="open-external" data-url="${esc(state.monetize.supporter.checkoutUrl)}">${esc(t('license.buy'))}</button>`
          : `<button class="btn btn-primary" data-action="license-howto">${esc(t('license.howtoBtn'))}</button>`}
      </div>
    </div>
  </div>
  <div class="card">
    <h3>${esc(t('license.sellTitle'))}</h3>
    <div class="muted small prewrap">${esc(t('license.sellBody'))}</div>
  </div>`;
}

// ---------------------------------------------------------------- console
/**
 * Append-only console. The old version rebuilt the whole log on every render
 * (and every render was triggered by the 3 s status poll), which threw away the
 * scroll position and — because it also called input.focus() — yanked the caret
 * out of the filter box while you were typing in it.
 */
function mountConsole() {
  const inst = state.instances.find((i) => i.id === state.activeId);
  if (!inst) return;
  const out = $('#console-output');
  if (!out) return;

  const lines = state.console[inst.id] || [];
  const fresh = out.dataset.inst !== inst.id;
  if (fresh) {
    out.dataset.inst = inst.id;
    out.dataset.rendered = '0';
    out.innerHTML = '';
  } else if (Number(out.dataset.rendered || 0) > lines.length) {
    // history was trimmed or reloaded -> start over
    out.dataset.rendered = '0';
    out.innerHTML = '';
  }

  const rendered = Number(out.dataset.rendered || 0);
  if (lines.length > rendered) {
    out.insertAdjacentHTML('beforeend', lines.slice(rendered).map(renderConsoleLine).join(''));
    out.dataset.rendered = String(lines.length);
    while (out.childElementCount > 1500) out.removeChild(out.firstChild);
    if (fresh) {
      // the element was recreated by a repaint: go back to where the user was reading
      out.scrollTop = state.autoScroll
        ? out.scrollHeight
        : Math.max(0, Math.min(state.consoleScroll || 0, out.scrollHeight));
    } else if (state.autoScroll) {
      out.scrollTop = out.scrollHeight;
    }
  }

  if (!out.dataset.wired) {
    out.dataset.wired = '1';
    out.addEventListener('scroll', () => {
      state.consoleScroll = out.scrollTop;
      const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      // an explicit click on the auto-scroll toggle wins until the user scrolls again
      if (!state.autoScrollManual) {
        state.autoScroll = nearBottom;
        const cb = $('#console-autoscroll');
        if (cb) cb.checked = nearBottom;
      }
    });
  }

  const input = $('#console-cmd');
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sendConsole(); }
    });
  }
  // Focus the command box when the tab is entered — but never pull the caret out
  // of a field the user is already typing in (the filter box, for instance).
  if (fresh && input && !activeControlIn($('#content'))) input.focus();

  const filter = $('#console-filter');
  if (filter) {
    if (filter.value !== (state.consoleFilter || '')) filter.value = state.consoleFilter || '';
    if (!filter.dataset.wired) {
      filter.dataset.wired = '1';
      filter.addEventListener('input', () => {
        state.consoleFilter = filter.value;
        applyConsoleFilter();
      });
    }
    applyConsoleFilter();
  }
}

function renderConsoleLine(entry) {
  const ts = entry.t ? `<span class="t">${esc(new Date(entry.t || Date.now()).toLocaleTimeString())}</span>` : '';
  return `<div class="line ${esc(entry.level || 'plain')}">${ts}${esc(entry.line)}</div>`;
}

function applyConsoleFilter() {
  const input = $('#console-filter');
  const q = (state.consoleFilter != null ? state.consoleFilter : (input ? input.value : '')) || '';
  const out = $('#console-output');
  if (!out) return;
  for (const line of $$('.line', out)) {
    line.style.display = !q || line.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  }
}

function appendConsole(id, entry) {
  if (!state.console[id]) state.console[id] = [];
  state.console[id].push(entry);
  if (state.console[id].length > 4000) state.console[id].splice(0, state.console[id].length - 4000);
  if (state.view !== 'server' || state.tab !== 'console' || state.activeId !== id) return;
  const out = $('#console-output');
  if (!out) { mountConsole(); return; }
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  out.insertAdjacentHTML('beforeend', renderConsoleLine(entry));
  out.dataset.rendered = String(state.console[id].length);
  while (out.childElementCount > 1500) out.removeChild(out.firstChild);
  if (state.autoScroll || atBottom) out.scrollTop = out.scrollHeight;
}

async function sendConsole() {
  const input = $('#console-cmd');
  if (!input || !state.activeId) return;
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  try { await call(api.instances.command(state.activeId, cmd)); } catch (err) { notifyError(err); }
}

// ---------------------------------------------------------------- wizard
function openWizard() {
  state.wizard = {
    step: 1,
    name: '',
    provider: state.settings.defaultProvider || 'paper',
    mcVersion: '',
    loaderVersion: '',
    memoryMB: state.settings.defaultMemoryMB || 4096,
    port: 25565,
    maxPlayers: 20,
    difficulty: 'normal',
    gamemode: 'survival',
    onlineMode: true,
    viewDistance: 10,
    includeSnapshots: false,
    experimental: false,
    eula: false,
    advancedConfirmed: false,
    versionFilter: ''
  };
  renderWizard();
}

function closeModal() {
  $('#modal-root').innerHTML = '';
  state.wizard = null;
}

// ---------------------------------------------------------------- dialogs
/**
 * In-app replacements for window.prompt() / confirm() / alert().
 *
 * Electron does not implement prompt() at all — calling it returns null and logs
 * "prompt() is and will not be supported", so every prompt-based action (new
 * folder, rename, licence removal) silently did nothing in the packaged app.
 * confirm() and alert() do work, but they block the whole renderer: the UI
 * freezes while the dialog is up, they look foreign next to the app's own
 * dialogs, and nothing in them can be driven by a test.
 *
 * Resolves with the trimmed text / true / false, or null when cancelled.
 */
function openDialog({ title, body = '', value = null, okLabel = null, cancelLabel = null, danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal dialog">
      <h2>${esc(title)}</h2>
      ${body ? `<div class="prewrap" style="margin-bottom:12px">${esc(body)}</div>` : ''}
      ${value === null ? '' : `<input type="text" id="dialog-input" autocomplete="off" value="${esc(value)}" style="width:100%" />`}
      <div class="modal-actions">
        ${showCancel ? `<button class="btn" data-dialog="cancel">${esc(cancelLabel || t('common.cancel'))}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-dialog="ok">${esc(okLabel || t('common.ok'))}</button>
      </div>
    </div>`;

    const input = wrap.querySelector('#dialog-input');
    let settled = false;
    const finish = (kind) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(kind === 'ok' ? (input ? (input.value.trim() || null) : true) : (input ? null : false));
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('ok'); }
    };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) finish('cancel'); });
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dialog]');
      if (b) { e.stopPropagation(); finish(b.dataset.dialog); }
    });
    wrap.addEventListener('input', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    // without this the dialog is built and then thrown away — the actions that
    // awaited it did nothing at all (found by the smoke test)
    $('#modal-root').appendChild(wrap);
    const ok = wrap.querySelector('[data-dialog="ok"]');
    if (input) { input.focus(); if (value) input.select(); } else if (ok) ok.focus();
  });
}

/** Text prompt -> string | null */
const askText = (opts) => openDialog({ value: '', ...opts });
/** Yes/no -> boolean */
const askConfirm = (opts) => openDialog({ ...opts, value: null });
/** Message with a single OK button */
const showInfo = (opts) => openDialog({ ...opts, value: null, showCancel: false });

function wizardProvider() {
  return state.providers.find((p) => p.id === state.wizard.provider) || state.providers[0];
}

async function loadWizardVersions() {
  const w = state.wizard;
  if (!w) return;
  busy('wizardVersions', true);
  try {
    const v = await call(api.providers.versions(w.provider, w.includeSnapshots)) || [];
    state.versions[w.provider] = v;
    if (!w.mcVersion || !v.some((x) => x.id === w.mcVersion)) w.mcVersion = v[0] ? v[0].id : '';
  } catch (err) {
    notifyError(err);
  } finally {
    busy('wizardVersions', false);
  }
}

async function loadWizardLoaders() {
  const w = state.wizard;
  const prov = wizardProvider();
  if (!w || !prov.supportsLoaders || !w.mcVersion) { state.loaders[w.provider] = []; return; }
  busy('wizardLoaders', true);
  try {
    const l = await call(api.providers.loaders(w.provider, w.mcVersion)) || [];
    state.loaders[w.provider] = l;
    if (!w.loaderVersion || !l.some((x) => x.id === w.loaderVersion)) {
      const stable = l.find((x) => x.stable) || l[0];
      w.loaderVersion = stable ? stable.id : '';
    }
  } catch (err) {
    notifyError(err);
    state.loaders[w.provider] = [];
  } finally {
    busy('wizardLoaders', false);
  }
}

function wizardCanNext() {
  const w = state.wizard;
  if (!w) return false;
  const prov = wizardProvider();
  if (w.step === 1) return !!String(w.name || '').trim() && (!prov.advanced || w.advancedConfirmed);
  if (w.step === 2) return !!w.mcVersion && (!prov.supportsLoaders || !!w.loaderVersion);
  if (w.step === 3) return w.memoryMB >= 512 && w.port > 1023;
  return w.eula;
}

/**
 * Live-enable the Next/Create button while typing.
 * Without this the wizard is a dead end: the button's disabled state is baked
 * into the markup at render time, and typing does not trigger a re-render.
 */
function updateWizardButtons() {
  const btn = document.querySelector('[data-action="wizard-next"], [data-action="wizard-create"]');
  if (!btn) return;
  const can = wizardCanNext();
  if (btn.disabled === can) btn.disabled = !can;
}

function renderWizard() {
  const w = state.wizard;
  if (!w) return;
  const prov = wizardProvider();
  const versions = (state.versions[w.provider] || []).filter((v) => !w.versionFilter || v.id.includes(w.versionFilter));
  const loaders = state.loaders[w.provider] || [];
  const steps = 4;

  const body = (() => {
    if (w.step === 1) {
      return `
        <label class="field"><span>${esc(t('wizard.name'))}</span>
          <input type="text" id="wz-name" value="${esc(w.name)}" placeholder="${esc(t('wizard.namePlaceholder'))}" /></label>
        <div class="field"><span style="font-size:12px;color:var(--muted)">${esc(t('wizard.type'))}</span>
          <div class="type-grid" style="margin-top:6px">
            ${state.providers.map((p) => `<button class="type-card ${p.id === w.provider ? 'selected' : ''}" data-action="wizard-type" data-id="${esc(p.id)}">
              <div class="t-name">${esc(p.label)} ${p.recommended ? `<span class="t-tag">${esc(t('wizard.recommended'))}</span>` : ''}</div>
              <div class="t-desc">${esc(t(`type.${p.id}.desc`))}</div>
            </button>`).join('')}
          </div>
        </div>
        ${prov.advanced ? `<div class="hint-box warn"><strong>${esc(t('wizard.advanced'))}</strong>
          <ul>${(prov.warnings || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <label class="check"><input type="checkbox" id="wz-advanced" ${w.advancedConfirmed ? 'checked' : ''} /><span>${esc(t('wizard.understand'))}</span></label>
        </div>` : ''}`;
    }
    if (w.step === 2) {
      return `
        <label class="check"><input type="checkbox" id="wz-snapshots" ${w.includeSnapshots ? 'checked' : ''} /><span>${esc(t('wizard.snapshots'))}</span></label>
        <label class="field"><span>${esc(t('wizard.filter'))}</span><input type="text" id="wz-filter" value="${esc(w.versionFilter)}" placeholder="1.21" /></label>
        ${busy('wizardVersions') ? `<div class="muted">${esc(t('common.loading'))}</div>` : `
        <div class="scroll-y" style="border:1px solid var(--line);border-radius:8px">
          ${versions.slice(0, 400).map((v) => `<button class="nav-item ${v.id === w.mcVersion ? 'active' : ''}" data-action="wizard-version" data-id="${esc(v.id)}">
            <span class="name mono">${esc(v.id)}</span><span class="muted small">${esc(v.type)}</span></button>`).join('')}
        </div>
        <div class="muted small" style="margin-top:6px">${versions.length} ${esc(t('wizard.versionsAvailable'))}</div>`}
        ${prov.supportsLoaders && w.mcVersion ? `
          <label class="field" style="margin-top:14px"><span>${esc(t('wizard.loader'))} (${esc(prov.label)})</span>
            <select id="wz-loader" class="select">
              ${busy('wizardLoaders') ? `<option>${esc(t('common.loading'))}</option>` : loaders.slice(0, 200).map((l) => `<option value="${esc(l.id)}" ${l.id === w.loaderVersion ? 'selected' : ''}>${esc(l.id)}${l.stable ? ` — ${esc(l.note || 'stable')}` : ''}</option>`).join('')}
            </select></label>` : ''}`;
    }
    if (w.step === 3) {
      return `
        <div class="grid cols-2">
          <label class="field"><span>${esc(t('wizard.memory'))}</span>
            <input type="number" id="wz-memory" min="512" step="512" value="${w.memoryMB}" /></label>
          <label class="field"><span>${esc(t('wizard.port'))}</span>
            <input type="number" id="wz-port" min="1024" max="65535" value="${w.port}" /></label>
          <label class="field"><span>${esc(t('wizard.maxPlayers'))}</span>
            <input type="number" id="wz-max" min="1" max="500" value="${w.maxPlayers}" /></label>
          <label class="field"><span>${esc(t('wizard.gamemode'))}</span>
            <select id="wz-gamemode" class="select">
              ${['survival', 'creative', 'adventure', 'spectator'].map((g) => `<option ${g === w.gamemode ? 'selected' : ''}>${g}</option>`).join('')}
            </select></label>
          <label class="field"><span>${esc(t('wizard.difficulty'))}</span>
            <select id="wz-difficulty" class="select">
              ${['peaceful', 'easy', 'normal', 'hard'].map((g) => `<option ${g === w.difficulty ? 'selected' : ''}>${g}</option>`).join('')}
            </select></label>
          <label class="field"><span>${esc(t('wizard.viewDistance'))}</span>
            <input type="number" id="wz-view" min="3" max="32" value="${w.viewDistance}" /></label>
        </div>
        <label class="check"><input type="checkbox" id="wz-online" ${w.onlineMode ? 'checked' : ''} /><span>${esc(t('wizard.onlineMode'))}</span></label>
        <label class="check"><input type="checkbox" id="wz-experimental" ${w.experimental ? 'checked' : ''} /><span>${esc(t('wizard.experimental'))}</span></label>`;
    }
    return `
      <div class="hint-box"><strong>${esc(w.name || t('wizard.unnamed'))}</strong><br>
        ${esc(prov.label)} ${esc(w.mcVersion)}${w.loaderVersion ? ` · ${esc(w.loaderVersion)}` : ''}<br>
        ${esc(t('wizard.memory'))}: ${w.memoryMB} MB · ${esc(t('wizard.port'))}: ${w.port} · ${esc(t('wizard.maxPlayers'))}: ${w.maxPlayers}</div>
      <div class="hint-box warn">${esc(t('eula.notice'))}</div>
      <label class="check"><input type="checkbox" id="wz-eula" ${w.eula ? 'checked' : ''} />
        <span>${esc(t('eula.acceptLong'))} <a href="#" data-action="open-external" data-url="https://aka.ms/MinecraftEULA">Minecraft EULA</a></span></label>`;
  })();

  const canNext = wizardCanNext();

  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">
    <div class="modal">
      <h2>${esc(t('wizard.title'))}</h2>
      <div class="muted small">${esc(t(`wizard.step${w.step}`))}</div>
      <div class="steps">${Array.from({ length: steps }, (_, i) => `<div class="step ${i < w.step ? 'active' : ''}"></div>`).join('')}</div>
      ${body}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="wizard-cancel">${esc(t('action.cancel'))}</button>
        ${w.step > 1 ? `<button class="btn" data-action="wizard-back">${esc(t('action.back'))}</button>` : ''}
        ${w.step < steps
          ? `<button class="btn btn-primary" data-action="wizard-next" ${canNext ? '' : 'disabled'}>${esc(t('action.next'))}</button>`
          : `<button class="btn btn-primary" data-action="wizard-create" ${canNext ? '' : 'disabled'}>${esc(t('wizard.createAndInstall'))}</button>`}
      </div>
    </div>
  </div>`;
}

function syncWizardFromDom() {
  const w = state.wizard;
  if (!w) return;
  const get = (sel) => { const el = $(sel); return el ? el.value : undefined; };
  const chk = (sel) => { const el = $(sel); return el ? el.checked : undefined; };
  const name = get('#wz-name'); if (name !== undefined) w.name = name;
  const adv = chk('#wz-advanced'); if (adv !== undefined) w.advancedConfirmed = adv;
  const snap = chk('#wz-snapshots'); if (snap !== undefined) w.includeSnapshots = snap;
  const filter = get('#wz-filter'); if (filter !== undefined) w.versionFilter = filter;
  const loader = get('#wz-loader'); if (loader !== undefined) w.loaderVersion = loader;
  const mem = get('#wz-memory'); if (mem !== undefined) w.memoryMB = Number(mem) || 4096;
  const port = get('#wz-port'); if (port !== undefined) w.port = Number(port) || 25565;
  const max = get('#wz-max'); if (max !== undefined) w.maxPlayers = Number(max) || 20;
  const gm = get('#wz-gamemode'); if (gm !== undefined) w.gamemode = gm;
  const df = get('#wz-difficulty'); if (df !== undefined) w.difficulty = df;
  const vd = get('#wz-view'); if (vd !== undefined) w.viewDistance = Number(vd) || 10;
  const on = chk('#wz-online'); if (on !== undefined) w.onlineMode = on;
  const exp = chk('#wz-experimental'); if (exp !== undefined) w.experimental = exp;
  const eula = chk('#wz-eula'); if (eula !== undefined) w.eula = eula;
}

async function wizardCreate() {
  syncWizardFromDom();
  const w = state.wizard;
  const prov = wizardProvider();
  try {
    busy('wizard-create', true);
    const meta = await call(api.instances.create({
      name: w.name,
      provider: w.provider,
      kind: prov.kind,
      mcVersion: w.mcVersion,
      loaderVersion: w.loaderVersion || null,
      memoryMB: w.memoryMB,
      port: w.port,
      rconPort: Math.min(65535, w.port + 10),
      maxPlayers: w.maxPlayers,
      difficulty: w.difficulty,
      gamemode: w.gamemode,
      onlineMode: w.onlineMode,
      viewDistance: w.viewDistance,
      acceptEula: w.eula,
      confirmedAdvanced: w.advancedConfirmed
    }));
    closeModal();
    await refreshInstances();
    state.activeId = meta.id;
    state.view = 'server';
    state.tab = 'overview';
    rerender();
    toast(t('wizard.created'), 'success');
    // install in the background
    call(api.instances.install(meta.id, w.experimental)).then(() => {
      toast(t('install.done'), 'success');
      refreshInstances().then(rerender);
      refreshStatuses().then(rerender);
    }).catch((err) => notifyError(err));
  } catch (err) {
    notifyError(err);
  } finally {
    busy('wizard-create', false);
  }
}

// ---------------------------------------------------------------- actions
const actions = {
  'new-server': () => openWizard(),
  'goto': (el) => { state.view = el.dataset.view; if (state.view === 'runtimes') refreshJava(); rerender(); },
  'open-instance': async (el) => {
    state.activeId = el.dataset.id;
    state.view = 'server';
    state.tab = 'overview';
    try {
      state.props[state.activeId] = await call(api.props.get(state.activeId));
    } catch { /* ignore */ }
    rerender();
  },
  // -------------------------------------------------------------- files ---
  'files-mode': async (el) => {
    const advanced = el.dataset.mode === 'advanced';
    state.settings = await call(api.app.setSettings({ filesAdvanced: advanced }));
    const cached = state.files[state.activeId];
    if (cached) cached.path = '';
    await refreshFiles('');
  },
  'files-nav': async (el) => { await refreshFiles(el.dataset.rel || ''); },
  'files-up': async () => {
    const cur = currentFilesRel();
    await refreshFiles(cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '');
  },
  'files-refresh': async () => { await refreshFiles(); toast(t('files.refreshed'), 'success', 1200); },
  'files-menu': async (el) => {
    state.filesMenu = state.filesMenu === el.dataset.rel ? null : el.dataset.rel;
    rerender();
  },
  'files-sort': async (el) => {
    const key = el.dataset.sort || 'name';
    const cur = state.filesSort || { key: 'name', dir: 1 };
    state.filesSort = cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 };
    rerender();
  },
  'files-copy-path': async (el) => {
    try {
      const abs = await call(api.files.path(state.activeId, el.dataset.rel));
      await copyText(String(abs));
      toast(t('toast.copied'), 'success', 1400);
    } catch (err) { notifyError(err); }
  },
  'files-open': async (el) => {
    try { await call(api.files.reveal(state.activeId, el.dataset.rel, true)); }
    catch (err) { notifyError(err); }
  },
  'files-reveal': async (el) => {
    try { await call(api.files.reveal(state.activeId, el.dataset.rel || '')); }
    catch (err) { notifyError(err); }
  },
  'files-mkdir': async () => {
    const name = await askText({ title: t('files.newFolder'), body: t('files.newFolderPrompt') });
    if (!name) return;
    try {
      await call(api.files.mkdir(state.activeId, currentFilesRel(), name));
      toast(t('files.created'), 'success', 1600);
      await refreshFiles();
    } catch (err) { notifyError(err); }
  },
  'files-import': async (el) => {
    try {
      const picked = await call(api.app.pickFile({ properties: ['openFile', 'multiSelections'] }));
      if (!picked || !picked.length) return;
      const target = el.dataset.rel || currentFilesRel();
      const added = await call(api.files.importFiles(state.activeId, target, picked));
      toast(`${t('files.imported')} ${added.length}`, 'success', 2200);
      await refreshFiles();
    } catch (err) { notifyError(err); }
  },
  'files-rename': async (el) => {
    const to = await askText({
      title: t('files.rename'),
      body: t('files.renamePrompt'),
      value: el.dataset.name || ''
    });
    if (!to || to === el.dataset.name) return;
    try {
      await call(api.files.rename(state.activeId, el.dataset.rel, to));
      toast(t('files.renamed'), 'success', 1600);
      await refreshFiles();
    } catch (err) { notifyError(err); }
  },
  'files-delete': async (el) => {
    const yes = await askConfirm({
      title: t('files.delete'),
      body: t('files.confirmDelete', { name: el.dataset.name }),
      okLabel: t('files.delete'),
      danger: true
    });
    if (!yes) return;
    try {
      await call(api.files.remove(state.activeId, el.dataset.rel));
      toast(t('files.deleted'), 'success', 1600);
      await refreshFiles();
    } catch (err) { notifyError(err); }
  },
  'tab': async (el) => {
    state.tab = el.dataset.tab;
    if (state.tab === 'console') {
      const id = state.activeId;
      if (state.lastConsoleId !== id) {
        state.lastConsoleId = id;
        try {
          state.console[id] = await call(api.instances.console(id, 500)) || [];
        } catch { state.console[id] = []; }
      }
    }
    if (state.tab === 'backups') refreshBackups();
    if (state.tab === 'addons') refreshAddons();
    if (state.tab === 'config') {
      try { state.props[state.activeId] = await call(api.props.get(state.activeId)); } catch { /* ignore */ }
    }
    if (state.tab === 'network') refreshTunnel();
    if (state.tab === 'files') refreshFiles();
    rerender();
  },
  'start': async (el) => {
    try { await call(api.instances.start(el.dataset.id)); toast(t('toast.starting'), 'success'); }
    catch (err) { notifyError(err); }
    refreshStatuses().then(rerender);
  },
  'stop': async (el) => {
    busy(`stop:${el.dataset.id}`, true);
    try { await call(api.instances.stop(el.dataset.id)); toast(t('toast.stopped'), 'success'); }
    catch (err) { notifyError(err); }
    busy(`stop:${el.dataset.id}`, false);
    refreshStatuses().then(rerender);
  },
  'kill': async (el) => {
    try { await call(api.instances.kill(el.dataset.id)); toast(t('toast.killed'), 'warn'); }
    catch (err) { notifyError(err); }
    refreshStatuses().then(rerender);
  },
  'restart': async (el) => {
    try { await call(api.instances.restart(el.dataset.id)); } catch (err) { notifyError(err); }
    refreshStatuses().then(rerender);
  },
  'install': async (el) => {
    const id = el.dataset.id;
    rerender();
    try {
      await call(api.instances.install(id, false));
      toast(t('install.done'), 'success');
    } catch (err) { notifyError(err); }
    refreshInstances().then(rerender);
  },
  'reinstall': async (el) => {
    const yes = await askConfirm({ title: t('config.reinstall'), body: t('config.reinstallConfirm'), danger: true });
    if (!yes) return;
    try {
      await call(api.instances.install(el.dataset.id, false));
      toast(t('install.done'), 'success');
    } catch (err) { notifyError(err); }
    refreshInstances().then(rerender);
  },
  'accept-eula': async (el) => {
    try { await call(api.instances.setEula(el.dataset.id, true)); toast(t('eula.accepted'), 'success'); }
    catch (err) { notifyError(err); }
    refreshInstances().then(rerender);
  },
  'open-eula': (el) => api.app.openExternal('https://aka.ms/MinecraftEULA'),
  'open-folder': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    if (inst) await call(api.app.openPath(`${state.appInfo.dataRoot}/instances/${inst.id}/server`));
  },
  'delete-instance': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    if (!inst) return;
    const yes = await askConfirm({
      title: t('action.delete'),
      body: t('confirm.delete', { name: inst.name }),
      okLabel: t('action.delete'),
      danger: true
    });
    if (!yes) return;
    try {
      await call(api.instances.remove(inst.id, true));
      toast(t('toast.deleted'), 'success');
    } catch (err) { notifyError(err); }
    await refreshInstances();
    state.view = state.instances.length ? 'server' : 'welcome';
    rerender();
  },
  'backup-now': async (el) => {
    const id = el.dataset.id;
    toast(t('backups.started'));
    try {
      const b = await call(api.backups.create(id));
      toast(`${t('backups.done')}: ${b.name} (${fmtBytes(b.bytes)})`, 'success');
      refreshBackups();
    } catch (err) { notifyError(err); }
  },
  'backup-refresh': (el) => refreshBackups(el.dataset.id),
  'backup-restore': async (el) => {
    const yes = await askConfirm({ title: t('backups.restore'), body: t('backups.restoreConfirm'), danger: true });
    if (!yes) return;
    try { await call(api.backups.restore(el.dataset.id, el.dataset.name)); toast(t('backups.restored'), 'success'); }
    catch (err) { notifyError(err); }
  },
  'backup-delete': async (el) => {
    const yes = await askConfirm({
      title: t('backups.delete'),
      body: t('confirm.deleteGeneric'),
      okLabel: t('files.delete'),
      danger: true
    });
    if (!yes) return;
    try { await call(api.backups.remove(el.dataset.id, el.dataset.name)); refreshBackups(el.dataset.id); }
    catch (err) { notifyError(err); }
  },
  'addon-search': async (el) => {
    const id = el.dataset.id;
    const source = ($('#addon-source') || {}).value || 'modrinth';
    const query = ($('#addon-query') || {}).value || '';
    const key = `addons:${id}`;
    state.addons = state.addons || {};
    state.addons[key] = { ...(state.addons[key] || {}), source, query, results: [], picked: null };
    rerender();
    try {
      state.addons[key].results = await call(api.plugins.search(id, source, query)) || [];
    } catch (err) { notifyError(err); }
    refreshAddons(id);
  },
  'addon-versions': async (el) => {
    const key = `addons:${el.dataset.id}`;
    state.addons = state.addons || {};
    try {
      const versions = await call(api.plugins.versions(el.dataset.id, el.dataset.source, el.dataset.project)) || [];
      const result = (state.addons[key].results || []).find((r) => r.id === el.dataset.project) || {};
      state.addons[key].picked = { name: result.name, versions };
    } catch (err) { notifyError(err); }
    rerender();
  },
  'addon-install': async (el) => {
    const id = el.dataset.id;
    const hash = el.dataset.hash;
    try {
      const res = await call(api.plugins.install(id, {
        downloadUrl: el.dataset.url,
        filename: el.dataset.file,
        hashes: hash ? { sha256: hash } : null
      }));
      toast(`${t('addons.installedOne')}: ${res.filename}`, 'success');
      refreshAddons(id);
    } catch (err) { notifyError(err); }
  },
  'addon-remove': async (el) => {
    const yes = await askConfirm({
      title: t('files.delete'),
      body: t('confirm.deleteGeneric'),
      okLabel: t('files.delete'),
      danger: true
    });
    if (!yes) return;
    try { await call(api.plugins.remove(el.dataset.id, el.dataset.file)); refreshAddons(el.dataset.id); }
    catch (err) { notifyError(err); }
  },
  'addon-toggle': async (el) => {
    try { await call(api.plugins.toggle(el.dataset.id, el.dataset.file)); refreshAddons(el.dataset.id); }
    catch (err) { notifyError(err); }
  },
  'rcon': async (el) => {
    try { const out = await call(api.instances.rcon(el.dataset.id, el.dataset.cmd)); toast(out || 'ok', 'success'); }
    catch (err) { notifyError(err); }
  },
  'player-act': async (el) => {
    const name = ($('#player-name') || {}).value;
    if (!name) return;
    try { await call(api.instances.rcon(el.dataset.id, `${el.dataset.cmd} ${name}`)); toast(`${el.dataset.cmd} ${name}`, 'success'); }
    catch (err) { notifyError(err); }
  },
  'console-send': () => sendConsole(),
  'console-clear': () => { if (state.activeId) state.console[state.activeId] = []; rerender(); },
  'copy': async (el) => {
    try {
      await copyText(el.dataset.text || '');
      toast(t('toast.copied'), 'success', 1600);
    } catch { toast(t('toast.copyFailed'), 'error'); }
  },
  'open-external': (el) => call(api.app.openExternal(el.dataset.url)),
  'open-data': () => call(api.app.openPath(state.appInfo.dataRoot)),
  'open-log': (el) => {
    const inst = state.instances.find((i) => i.id === (el.dataset.id || state.activeId));
    if (inst) call(api.app.openPath(`${state.appInfo.dataRoot}/instances/${inst.id}/logs`));
  },
  'open-app-log': () => call(api.app.openPath(`${state.appInfo.dataRoot}/logs/app.log`)),
  'open-locales': () => call(api.app.openPath(`${state.appInfo.dataRoot}/locales`)),
  'open-diagnostics': async () => {
    try {
      const d = await call(api.app.diagnostics());
      alert(`${t('settings.diagnostics')}\n\n${JSON.stringify(d, null, 2)}`);
    } catch (err) { notifyError(err); }
  },
  'i18n-export': async () => {
    try {
      const p = await call(api.i18n.exportTemplate(state.settings.language || 'en'));
      if (p) toast(`${t('settings.exported')}: ${p}`, 'success');
    } catch (err) { notifyError(err); }
  },
  'i18n-import': async () => {
    try {
      const res = await call(api.i18n.importFile());
      if (res) {
        toast(`${t('settings.imported')}: ${res.code}`, 'success');
        state.languages = (await call(api.i18n.list())) || [];
        rerender();
      }
    } catch (err) { notifyError(err); }
  },
  'upnp': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    if (!inst) return;
    toast(t('network.upnpWorking'));
    try {
      const res = await call(api.network.upnp(inst.port, `MCServerSmith ${inst.name}`));
      if (res.ok) toast(`${t('network.upnpOk')}: ${res.address || ''}`, 'success');
      else toast(`${t('network.upnpFail')}: ${res.reason}`, 'warn', 7000);
    } catch (err) { notifyError(err); }
  },
  'tunnel-provider': async (el) => {
    state.wizardTunnelDraft = true;
    const inst = state.instances.find((i) => i.id === state.activeId);
    if (!inst) return;
    const provider = el.value;
    await call(api.instances.update(inst.id, { tunnel: { ...(inst.tunnel || {}), provider } }));
    await refreshInstances();
    rerender();
  },
  'tunnel-save': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    if (!inst) return;
    const patch = { ...(inst.tunnel || {}) };
    for (const input of $$('[data-tunnel]')) {
      const key = input.dataset.tunnel;
      patch[key] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Number(input.value) : input.value);
    }
    try {
      await call(api.instances.update(inst.id, { tunnel: patch }));
      toast(t('toast.saved'), 'success');
    } catch (err) { notifyError(err); }
    refreshInstances().then(rerender);
  },
  'tunnel-start': async (el) => {
    try { const info = await call(api.tunnel.start(el.dataset.id)); toast(`${t('network.tunnelUp')}: ${info && info.address || ''}`, 'success'); }
    catch (err) { notifyError(err); }
    refreshTunnel(el.dataset.id);
  },
  'tunnel-stop': async (el) => {
    try { await call(api.tunnel.stop(el.dataset.id)); toast(t('network.tunnelDown'), 'warn'); }
    catch (err) { notifyError(err); }
    refreshTunnel(el.dataset.id);
  },
  'pick-playit': async () => {
    try {
      const files = await call(api.app.pickFile({ properties: ['openFile'] }));
      if (files && files[0]) {
        const inst = state.instances.find((i) => i.id === state.activeId);
        await call(api.instances.update(inst.id, { tunnel: { ...(inst.tunnel || {}), playitPath: files[0] } }));
        await refreshInstances();
        rerender();
      }
    } catch (err) { notifyError(err); }
  },
  'provision-java': async (el) => {
    const feature = Number(el.dataset.feature);
    toast(`Java ${feature}…`);
    try { await call(api.java.provision(feature, 'jre')); toast(`Java ${feature} ${t('runtimes.done')}`, 'success'); }
    catch (err) { notifyError(err); }
    refreshJava();
  },
  'refresh-java': () => refreshJava(),
  'save-props': async (el) => {
    const patch = {};
    for (const input of $$('[data-prop]')) {
      patch[input.dataset.prop] = input.type === 'checkbox' ? String(input.checked) : input.value;
    }
    try {
      await call(api.props.set(el.dataset.id, patch));
      state.props[el.dataset.id] = await call(api.props.get(el.dataset.id));
      toast(t('toast.saved'), 'success');
    } catch (err) { notifyError(err); }
  },
  'save-instance': async (el) => {
    const patch = {};
    for (const input of $$('[data-inst]')) {
      if (input.dataset.inst !== el.dataset.id) continue;
      const field = input.dataset.field;
      patch[field] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Number(input.value) : input.value);
    }
    try {
      await call(api.instances.update(el.dataset.id, patch));
      toast(t('toast.saved'), 'success');
    } catch (err) { notifyError(err); }
    refreshInstances().then(rerender);
  },
  'set-backup-enabled': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    await call(api.instances.update(el.dataset.id, { backup: { ...(inst.backup || {}), enabled: el.checked } }));
    refreshInstances().then(rerender);
  },
  'set-backup-interval': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    await call(api.instances.update(el.dataset.id, { backup: { ...(inst.backup || {}), intervalHours: Number(el.value) } }));
  },
  'set-backup-keep': async (el) => {
    const inst = state.instances.find((i) => i.id === el.dataset.id);
    await call(api.instances.update(el.dataset.id, { backup: { ...(inst.backup || {}), keep: Number(el.value) } }));
  },
  'license-activate': async () => {
    const key = ($('#license-key') || {}).value;
    if (!key) return;
    try {
      state.license = await call(api.license.activate(key));
      toast(t('license.activated'), 'success');
      state.upsell = null;
    } catch (err) { notifyError(err); }
    rerender();
  },
  'license-remove': async (el) => {
    // the preview is not the key — ask for the full key instead
    const key = prompt(t('license.removePrompt'));
    if (!key) return;
    try { state.license = await call(api.license.deactivate(key)); toast(t('license.removed'), 'success'); }
    catch (err) { notifyError(err); }
    rerender();
  },
  'license-howto': () => {
    alert(`${t('license.howtoTitle')}\n\n${t('license.howtoBody')}`);
  },
  'upsell-open': (el) => {
    state.view = el.dataset.feature === 'cloud' ? 'cloud' : 'license';
    rerender();
  },
  'upsell-dismiss': async (el) => {
    state.upsell = null;
    try { await call(api.monetize.dismiss(el.dataset.kind)); } catch { /* ignore */ }
    rerender();
  },
  // Settings tab language picker — must reload the dictionary, not just store it
  'setting-language': async (el) => {
    const code = el.value;
    state.settings = await call(api.app.setSettings({ language: code }));
    await loadLanguage(code);
    renderLanguageSelect();
    rerender();
    toast(t('toast.saved'), 'success', 1400);
  },
  'modal-backdrop': (el, ev) => { if (ev.target === el) closeModal(); },
  'wizard-cancel': () => closeModal(),
  'wizard-type': async (el) => {
    syncWizardFromDom();
    state.wizard.provider = el.dataset.id;
    state.wizard.mcVersion = '';
    state.wizard.loaderVersion = '';
    renderWizard();
    await loadWizardVersions();
    renderWizard();
  },
  'wizard-version': async (el) => {
    syncWizardFromDom();
    state.wizard.mcVersion = el.dataset.id;
    renderWizard();
    await loadWizardLoaders();
    renderWizard();
  },
  'wizard-next': async () => {
    syncWizardFromDom();
    const w = state.wizard;
    if (w.step === 1) { await loadWizardVersions(); w.step = 2; }
    else if (w.step === 2) { await loadWizardLoaders(); w.step = 3; }
    else w.step += 1;
    renderWizard();
  },
  'wizard-back': () => { syncWizardFromDom(); state.wizard.step -= 1; renderWizard(); },
  'wizard-create': () => wizardCreate()
};

document.addEventListener('click', (ev) => {
  // selects fire their action on 'change', not on click — re-rendering while the
  // native dropdown is open would close it again immediately
  if (ev.target.matches('select, option')) return;
  const el = ev.target.closest('[data-action]');
  if (!el) {
    // a click that hits no action still closes an open file-row menu
    if (state.filesMenu) { state.filesMenu = null; rerender(); }
    return;
  }
  if (state.filesMenu && el.dataset.action !== 'files-menu') state.filesMenu = null;
  const handler = actions[el.dataset.action];
  if (!handler) return;
  if (ev.target.closest('a') && el.dataset.action !== 'open-external') return;
  // NEVER preventDefault a click on a form control: cancelling a checkbox/radio
  // click reverts the toggle. This killed every checkbox inside the wizard,
  // because the modal backdrop carries data-action and therefore matched
  // closest('[data-action]') for anything inside the dialog.
  const isControl = ev.target.matches('input, textarea, label');
  if (!isControl) ev.preventDefault();
  try {
    handler(el, ev);
  } catch (err) {
    notifyError(err);
  }
});

// double-click a row: enter the folder / open the file. Right-click opens the
// same row menu the ⋯ button shows — no need to hit the small button.
document.addEventListener('dblclick', (ev) => {
  const row = ev.target.closest('tr.file-row');
  if (!row || !row.dataset.rel) return;
  if (row.dataset.dir === '1') refreshFiles(row.dataset.rel);
  else call(api.files.reveal(state.activeId, row.dataset.rel, true)).catch(notifyError);
});

document.addEventListener('contextmenu', (ev) => {
  const row = ev.target.closest('tr.file-row');
  if (!row) return;   // everywhere else the platform menu stays untouched
  ev.preventDefault();
  state.filesMenu = row.dataset.rel;
  rerender();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.filesMenu) { state.filesMenu = null; rerender(); }
});

document.addEventListener('change', async (ev) => {
  const target = ev.target;

  // A control's OWN data-action wins (change events bubble to the backdrop too,
  // so closest() would be wrong here).
  const ownAction = target.dataset ? target.dataset.action : null;
  if (ownAction && actions[ownAction]) {
    try { await actions[ownAction](target, ev); } catch (err) { notifyError(err); }
    return;
  }

  // wizard fields (snapshots toggle -> reload the version list)
  if (target.closest('.modal')) {
    syncWizardFromDom();
    if (target.id === 'wz-snapshots') {
      const w = state.wizard;
      if (w) { w.mcVersion = ''; state.loaders[w.provider] = []; }
      await loadWizardVersions();
      renderWizard();
    } else {
      updateWizardButtons();
      if (target.id === 'wz-loader' || target.id === 'wz-gamemode' || target.id === 'wz-difficulty') renderWizard();
    }
    return;
  }

  // console auto-scroll: an explicit click must stick, so mark it manual
  if (target.id === 'console-autoscroll') {
    state.autoScroll = target.checked;
    state.autoScrollManual = true;
    if (target.checked) {
      const out = $('#console-output');
      if (out) out.scrollTop = out.scrollHeight;
    }
    return;
  }

  // application settings
  const s = target.closest('[data-setting]');
  if (s) {
    const key = s.dataset.setting;
    const value = s.type === 'checkbox' ? s.checked : (s.type === 'number' ? Number(s.value) : s.value);
    state.settings = await call(api.app.setSettings({ [key]: value }));
    rerender();
    return;
  }

  // server.properties checkbox -> persist immediately instead of silently
  // waiting for the Save button (that is what made checkboxes feel dead)
  if (target.matches('input[type=checkbox][data-prop]')) {
    const inst = state.instances.find((i) => i.id === state.activeId);
    if (!inst) return;
    const patch = {};
    for (const input of $$('[data-prop]')) {
      patch[input.dataset.prop] = input.type === 'checkbox' ? String(input.checked) : input.value;
    }
    try {
      state.props[inst.id] = await call(api.props.set(inst.id, patch));
      toast(t('toast.saved'), 'success', 1400);
    } catch (err) { notifyError(err); }
    return;
  }

  // launcher/instance checkboxes (auto-restart, schedule)
  if (target.matches('input[type=checkbox][data-inst][data-field]')) {
    try {
      await call(api.instances.update(target.dataset.inst, { [target.dataset.field]: target.checked }));
      await refreshInstances();
      rerender();
    } catch (err) { notifyError(err); }
    return;
  }

  // tunnel options (e.g. PROXY protocol)
  if (target.matches('input[type=checkbox][data-tunnel]')) {
    const inst = state.instances.find((i) => i.id === state.activeId);
    if (!inst) return;
    const patch = { ...(inst.tunnel || {}) };
    for (const input of $$('[data-tunnel]')) {
      patch[input.dataset.tunnel] = input.type === 'checkbox'
        ? input.checked
        : (input.type === 'number' ? Number(input.value) : input.value);
    }
    try {
      await call(api.instances.update(inst.id, { tunnel: patch }));
      await refreshInstances();
      toast(t('toast.saved'), 'success', 1400);
    } catch (err) { notifyError(err); }
    return;
  }
});

// live feedback while typing
document.addEventListener('input', async (ev) => {
  // language switch
  if (ev.target.id === 'language-select') {
    const code = ev.target.value;
    state.settings = await call(api.app.setSettings({ language: code }));
    await loadLanguage(code);
    rerender();
    return;
  }
  // files tab: filter the rows in place — no re-render, so the caret stays put
  if (ev.target.id === 'files-filter') {
    state.filesFilter = ev.target.value;
    applyFilesFilter();
    return;
  }
  // wizard: keep the Next button in sync with what was typed, filter live
  if (ev.target.closest('.modal')) {
    syncWizardFromDom();
    if (ev.target.id === 'wz-filter') {
      const q = String(ev.target.value || '').toLowerCase();
      for (const btn of document.querySelectorAll('[data-action="wizard-version"]')) {
        btn.style.display = !q || String(btn.dataset.id).toLowerCase().includes(q) ? '' : 'none';
      }
    }
    updateWizardButtons();
  }
});

// ---------------------------------------------------------------- loaders
async function refreshBackups(id) {
  const iid = id || state.activeId;
  if (!iid) return;
  state.backups = state.backups || {};
  try { state.backups[`backups:${iid}`] = await call(api.backups.list(iid)) || []; } catch { /* ignore */ }
  rerender();
}

async function refreshAddons(id) {
  const iid = id || state.activeId;
  if (!iid) return;
  state.addons = state.addons || {};
  const key = `addons:${iid}`;
  state.addons[key] = state.addons[key] || { source: 'modrinth', query: '', results: [] };
  try { state.addons[key].installed = await call(api.plugins.installed(iid)); } catch { /* ignore */ }
  rerender();
}

async function refreshTunnel(id) {
  const iid = id || state.activeId;
  if (!iid) return;
  state.tunnelStatus = state.tunnelStatus || {};
  try { state.tunnelStatus[iid] = await call(api.tunnel.status(iid)); } catch { /* ignore */ }
  rerender();
}

async function refreshJava() {
  try { state.java = await call(api.java.installed()) || []; } catch { state.java = []; }
  rerender();
}

// ---------------------------------------------------------------- events
api.onServerEvent(async (ev) => {
  const { type, id, payload } = ev;
  if (type === 'log') {
    appendConsole(id, payload);
    return;
  }
  if (type === 'progress') {
    if (!state.statuses[id]) state.statuses[id] = {};
    state.statuses[id].install = payload.phase === 'done' ? null : payload;
    if (payload.phase === 'error') toast(payload.message, 'error', 8000);
    rerender({ force: false });
    return;
  }
  if (type === 'state') {
    if (!state.statuses[id]) state.statuses[id] = {};
    Object.assign(state.statuses[id], { state: payload.state, pid: payload.pid, startedAt: payload.startedAt });
    refreshInstances().then(() => { rerender({ force: false }); refreshStatuses().then(() => rerender({ force: false })); });
    return;
  }
  if (type === 'players') {
    if (!state.statuses[id]) state.statuses[id] = {};
    state.statuses[id].players = payload;
    rerender({ force: false });
    return;
  }
  if (type === 'metrics') {
    if (!state.statuses[id]) state.statuses[id] = {};
    state.statuses[id].metrics = payload;
    if (state.tab === 'overview') rerender({ force: false });
    return;
  }
  if (type === 'updated' || type === 'created' || type === 'deleted') {
    refreshInstances().then(rerender);
    return;
  }
  if (type === 'error') {
    toast(payload.message, 'error', 8000);
    if (payload.upsell) {
      state.upsell = { feature: payload.upsell, kind: 'license' };
      rerender();
    }
    return;
  }
  if (type === 'status') {
    state.statuses[id] = payload;
    rerender({ force: false });
  }
});

api.onMenu((msg) => {
  if (msg.action === 'new-server') openWizard();
});

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    state.settings = await call(api.app.getSettings()) || {};
    state.fallback = {};
    try { state.fallback = await call(api.i18n.get('en')) || {}; } catch { /* ignore */ }
    await loadAll();
    refreshJava();
  } catch (err) {
    notifyError(err);
  }
  render();
  // periodic status refresh — background updates, so they never take the caret
  setInterval(() => { refreshStatuses().then(() => rerender({ force: false })).catch(() => {}); }, 3000);
  setInterval(() => {
    call(api.monetize.suggest()).then((u) => {
      const changed = JSON.stringify(u) !== JSON.stringify(state.upsell);
      state.upsell = u;
      if (changed) rerender({ force: false });
    }).catch(() => {});
  }, 60000);
}

boot();
