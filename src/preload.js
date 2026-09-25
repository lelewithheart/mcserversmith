'use strict';
/** Renderer bridge. contextIsolation is on — this is the only exposed surface. */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(`mcss:${channel}`, payload);

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
  }
};

contextBridge.exposeInMainWorld('mcss', api);
