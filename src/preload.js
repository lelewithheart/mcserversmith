'use strict';
/** Renderer bridge. contextIsolation is on — this is the only exposed surface. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(`mcss:${channel}`, payload);

// ---------------------------------------------------------------- file drops
// Electron 32 removed File.path, so the path of a dropped file can only be read
// in the preload via webUtils. Catch the drop here, forward the paths to the
// renderer, which knows the instance and folder that is on screen.
const dropZoneOf = (target) => (target && target.closest ? target.closest('[data-drop-zone]') : null);
window.addEventListener('dragover', (ev) => {
  if (dropZoneOf(ev.target)) {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }
}, true);
window.addEventListener('drop', (ev) => {
  const zone = dropZoneOf(ev.target);
  if (!zone) return;
  ev.preventDefault();
  const paths = Array.from((ev.dataTransfer && ev.dataTransfer.files) || [])
    .map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } })
    .filter(Boolean);
  if (paths.length) ipcRenderer.send(`mcss:files:dropped`, { paths });
}, true);

const api = {
  app: {
    info: () => invoke('app:info'),
    diagnostics: () => invoke('app:diagnostics'),
    getSettings: () => invoke('app:settings:get'),
    setSettings: (patch) => invoke('app:settings:set', patch),
    resetSettings: () => invoke('app:settings:reset'),
    logs: (limit) => invoke('app:logs', { limit }),
    openExternal: (url) => invoke('app:openExternal', { url }),
    openPath: (target) => invoke('app:openPath', { target }),
    pickFile: (opts) => invoke('app:pickFile', opts || {}),
    saveFile: (opts) => invoke('app:saveFile', opts || {})
  },
  providers: {
    list: () => invoke('providers:list'),
    versions: (provider, includeSnapshots) => invoke('providers:versions', { provider, includeSnapshots }),
    loaders: (provider, mcVersion) => invoke('providers:loaders', { provider, mcVersion }),
    resolve: (provider, mcVersion, loaderVersion) => invoke('providers:resolve', { provider, mcVersion, loaderVersion })
  },
  instances: {
    list: () => invoke('instances:list'),
    get: (id) => invoke('instances:get', { id }),
    create: (opts) => invoke('instances:create', opts),
    update: (id, patch) => invoke('instances:update', { id, patch }),
    remove: (id, deleteFiles) => invoke('instances:remove', { id, deleteFiles }),
    install: (id, experimental) => invoke('instances:install', { id, experimental }),
    setEula: (id, accepted) => invoke('instances:setEula', { id, accepted }),
    start: (id) => invoke('instances:start', { id }),
    stop: (id) => invoke('instances:stop', { id }),
    kill: (id) => invoke('instances:kill', { id }),
    restart: (id) => invoke('instances:restart', { id }),
    command: (id, command) => invoke('instances:command', { id, command }),
    rcon: (id, command) => invoke('instances:rcon', { id, command }),
    status: (id) => invoke('instances:status', { id }),
    statuses: () => invoke('instances:statuses'),
    console: (id, limit) => invoke('instances:console', { id, limit })
  },
  props: {
    get: (id) => invoke('props:get', { id }),
    set: (id, patch) => invoke('props:set', { id, patch })
  },
  files: {
    list: (id, rel = '') => invoke('files:list', { id, rel }),
    simple: (id) => invoke('files:simple', { id }),
    mkdir: (id, rel, name) => invoke('files:mkdir', { id, rel, name }),
    rename: (id, rel, to) => invoke('files:rename', { id, rel, to }),
    remove: (id, rel) => invoke('files:delete', { id, rel }),
    importFiles: (id, rel, sources) => invoke('files:import', { id, rel, sources }),
    size: (id, rel) => invoke('files:size', { id, rel }),
    path: (id, rel = '') => invoke('files:path', { id, rel }),
    read: (id, rel) => invoke('files:read', { id, rel }),
    write: (id, rel, text, expectSize = null) => invoke('files:write', { id, rel, text, expectSize }),
    // test hook: pretend these paths were dropped on the file browser
    __simulateDrop: (paths) => ipcRenderer.send(`mcss:files:dropped`, { paths }),
    reveal: (id, rel, openWithDefault = false) => invoke('files:reveal', { id, rel, openWithDefault })
  },
  backups: {
    list: (id) => invoke('backup:list', { id }),
    create: (id, label) => invoke('backup:create', { id, label }),
    restore: (id, name) => invoke('backup:restore', { id, name }),
    remove: (id, name) => invoke('backup:delete', { id, name }),
    prune: (id, keep) => invoke('backup:prune', { id, keep }),
    usage: (id) => invoke('backup:usage', { id })
  },
  plugins: {
    search: (id, source, query) => invoke('plugins:search', { id, source, query }),
    versions: (id, source, projectId) => invoke('plugins:versions', { id, source, projectId }),
    install: (id, payload) => invoke('plugins:install', { id, ...payload }),
    installed: (id) => invoke('plugins:installed', { id }),
    remove: (id, filename) => invoke('plugins:remove', { id, filename }),
    toggle: (id, filename) => invoke('plugins:toggle', { id, filename })
  },
  network: {
    upnp: (port, description) => invoke('network:upnp', { port, description }),
    upnpRemove: (port) => invoke('network:upnp:remove', { port })
  },
  tunnel: {
    status: (id) => invoke('tunnel:status', { id }),
    start: (id) => invoke('tunnel:start', { id }),
    stop: (id) => invoke('tunnel:stop', { id })
  },
  java: {
    installed: () => invoke('java:installed'),
    provision: (feature, kind) => invoke('java:provision', { feature, kind })
  },
  license: {
    status: () => invoke('license:status'),
    activate: (key, label) => invoke('license:activate', { key, label }),
    deactivate: (key) => invoke('license:deactivate', { key })
  },
  monetize: {
    info: () => invoke('monetize:info'),
    suggest: () => invoke('monetize:suggest'),
    dismiss: (kind) => invoke('monetize:dismiss', { kind })
  },
  i18n: {
    list: () => invoke('i18n:list'),
    get: (code) => invoke('i18n:get', { code }),
    exportTemplate: (code) => invoke('i18n:export', { code }),
    importFile: () => invoke('i18n:import')
  },
  onServerEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('server-event', listener);
    return () => ipcRenderer.removeListener('server-event', listener);
  },
  onAppLog: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('app-log', listener);
    return () => ipcRenderer.removeListener('app-log', listener);
  },
  onMenu: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
  onFilesDropped: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('files-dropped', listener);
    return () => ipcRenderer.removeListener('files-dropped', listener);
  }
};

contextBridge.exposeInMainWorld('mcss', api);
