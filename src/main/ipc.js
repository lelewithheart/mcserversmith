'use strict';
/**
 * IPC surface. Every handler returns { ok, data } or { ok:false, error, code }
 * so the renderer never has to deal with thrown Electron serialisation errors.
 */
const path = require('path');
const fs = require('fs');

const { getDirs } = require('./core/paths');
const { createLogger, getLogRing, which } = require('./core/util');
const settings = require('./core/settings');
const providerRegistry = require('./providers');
require('./providers/mojang');
require('./providers/fill');
require('./providers/purpur');
require('./providers/fabric');
require('./providers/forge');
require('./providers/spigot');

const instances = require('./servers/instances');
const backup = require('./servers/backup');
const plugins = require('./servers/plugins');
const props = require('./servers/props');
const upnp = require('./servers/upnp');
const tunnel = require('./net/tunnel');
const javaruntime = require('./java/runtime');
const license = require('./licensing/license');
const monetize = require('./licensing/monetize');
const { getDirs: dirs } = require('./core/paths');

const log = createLogger('ipc');

// i18n for the community translation import/export
const BUNDLED_LOCALES = path.join(__dirname, '..', 'renderer', 'locales');

function wrap(fn) {
  return async (_event, payload) => {
    try {
      const data = await fn(payload || {});
      return { ok: true, data };
    } catch (err) {
      const out = { ok: false, error: err.message || String(err) };
      if (err.code) out.code = err.code;
      if (err.warnings) out.warnings = err.warnings;
      if (err.feature) out.feature = err.feature;
      log.warn(`ipc error: ${out.error}`);
      return out;
    }
  };
}

function register({ ipcMain, manager, shell, dialog, app, getWindow }) {
  const M = 'mcss';

  // ---------------------------------------------------------------- app ----
  ipcMain.handle(`${M}:app:info`, wrap(() => manager.appInfo()));
  ipcMain.handle(`${M}:app:settings:get`, wrap(() => settings.all()));
  ipcMain.handle(`${M}:app:settings:set`, wrap((patch) => settings.set(patch)));
  ipcMain.handle(`${M}:app:settings:reset`, wrap(() => settings.reset()));
  ipcMain.handle(`${M}:app:logs`, wrap(({ limit = 300 } = {}) => getLogRing(limit)));
  ipcMain.handle(`${M}:app:openExternal`, wrap(({ url }) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
    return shell.openExternal(url).then(() => true);
  }));
  ipcMain.handle(`${M}:app:openPath`, wrap(({ target }) => shell.openPath(target).then((err) => {
    if (err) throw new Error(err);
    return true;
  })));
  ipcMain.handle(`${M}:app:pickFile`, wrap(async ({ filters, properties }) => {
    const res = await dialog.showOpenDialog(getWindow(), {
      properties: properties || ['openFile'],
      filters: filters || undefined
    });
    return res.canceled ? null : res.filePaths;
  }));
  ipcMain.handle(`${M}:app:saveFile`, wrap(async ({ defaultPath, filters }) => {
    const res = await dialog.showSaveDialog(getWindow(), { defaultPath, filters });
    return res.canceled ? null : res.filePath;
  }));
  ipcMain.handle(`${M}:app:diagnostics`, wrap(() => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    dataRoot: getDirs().root,
    tools: { git: which('git'), tar: which('tar'), unzip: which('unzip') },
    licenses: license.status(),
    // required by the Minecraft Usage Guidelines on any related material,
    // and useful in bug reports
    disclaimer: 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.',
    contact: 'leonhardyvon@gmx.net',
    copyright: 'MIT © 2026 Leonhard Yvon'
  })));

  // ----------------------------------------------------------- providers ---
  ipcMain.handle(`${M}:providers:list`, wrap(() => providerRegistry.list()));
  ipcMain.handle(`${M}:providers:versions`, wrap(({ provider, includeSnapshots = false }) =>
    providerRegistry.get(provider).listMcVersions({ includeSnapshots })));
  ipcMain.handle(`${M}:providers:loaders`, wrap(async ({ provider, mcVersion }) => {
    const p = providerRegistry.get(provider);
    if (!p.supportsLoaders) return [];
    return p.listLoaders(mcVersion);
  }));
  ipcMain.handle(`${M}:providers:resolve`, wrap(({ provider, mcVersion, loaderVersion }) =>
    providerRegistry.get(provider).resolve({ mcVersion, loaderVersion })));

  // ---------------------------------------------------------- instances ---
  ipcMain.handle(`${M}:instances:list`, wrap(() => manager.listInstances()));
  ipcMain.handle(`${M}:instances:get`, wrap(({ id }) => manager.getInstance(id)));
  ipcMain.handle(`${M}:instances:create`, wrap((opts) => manager.createInstance(opts)));
  ipcMain.handle(`${M}:instances:update`, wrap(({ id, patch }) => manager.updateInstance(id, patch)));
  ipcMain.handle(`${M}:instances:remove`, wrap(({ id, deleteFiles = true }) => manager.deleteInstance(id, { deleteFiles })));
  ipcMain.handle(`${M}:instances:install`, wrap(({ id, experimental = false }) => manager.installInstance(id, { experimental })));
  ipcMain.handle(`${M}:instances:setEula`, wrap(({ id, accepted }) => manager.setEula(id, accepted)));
  ipcMain.handle(`${M}:instances:start`, wrap(({ id }) => manager.startInstance(id)));
  ipcMain.handle(`${M}:instances:stop`, wrap(({ id, force = false }) => manager.stopInstance(id, { force })));
  ipcMain.handle(`${M}:instances:kill`, wrap(({ id }) => manager.killInstance(id)));
  ipcMain.handle(`${M}:instances:restart`, wrap(({ id }) => manager.restartInstance(id)));
  ipcMain.handle(`${M}:instances:command`, wrap(({ id, command }) => manager.sendCommand(id, command)));
  ipcMain.handle(`${M}:instances:rcon`, wrap(({ id, command }) => manager.rconCommand(id, command)));
  ipcMain.handle(`${M}:instances:status`, wrap(({ id }) => manager.status(id)));
  ipcMain.handle(`${M}:instances:statuses`, wrap(() => manager.statuses()));
  ipcMain.handle(`${M}:instances:console`, wrap(({ id, limit = 500 }) => manager.getConsole(id, limit)));

  // server.properties
  ipcMain.handle(`${M}:props:get`, wrap(({ id }) => {
    const p = instances.instancePaths(id);
    const entries = props.readProperties(p.properties);
    return { path: p.properties, entries, values: props.toObject(entries) };
  }));
  ipcMain.handle(`${M}:props:set`, wrap(({ id, patch }) => {
    const p = instances.instancePaths(id);
    return props.writeProperties(p.properties, patch);
  }));

  // ------------------------------------------------------------ backups ---
  ipcMain.handle(`${M}:backup:list`, wrap(({ id }) => backup.listBackups(id)));
  ipcMain.handle(`${M}:backup:create`, wrap(({ id, label = null }) => backup.createBackup(manager, id, { label })));
  ipcMain.handle(`${M}:backup:restore`, wrap(({ id, name }) => backup.restoreBackup(manager, id, name)));
  ipcMain.handle(`${M}:backup:delete`, wrap(({ id, name }) => backup.deleteBackup(id, name)));
  ipcMain.handle(`${M}:backup:prune`, wrap(({ id, keep = 7 }) => backup.pruneBackups(id, keep)));
  ipcMain.handle(`${M}:backup:usage`, wrap(({ id }) => backup.backupUsage(id)));

  // ------------------------------------------------------------ plugins ---
  ipcMain.handle(`${M}:plugins:search`, wrap(({ id, source = 'modrinth', query = '', limit = 20 }) => {
    const meta = instances.read(id);
    return plugins.search({ source, query, meta, mcVersion: meta.mcVersion, limit });
  }));
  ipcMain.handle(`${M}:plugins:versions`, wrap(({ id, source = 'modrinth', projectId, limit = 20 }) => {
    const meta = instances.read(id);
    return plugins.versions({ source, id: projectId, meta, mcVersion: meta.mcVersion, limit });
  }));
  ipcMain.handle(`${M}:plugins:install`, wrap(({ id, downloadUrl, filename, hashes }) =>
    plugins.install(manager, id, { downloadUrl, filename, hashes })));
  ipcMain.handle(`${M}:plugins:installed`, wrap(({ id }) => plugins.installedAddons(id)));
  ipcMain.handle(`${M}:plugins:remove`, wrap(({ id, filename }) => plugins.removeAddon(id, filename)));
  ipcMain.handle(`${M}:plugins:toggle`, wrap(({ id, filename }) => plugins.toggleAddon(id, filename)));

  // ------------------------------------------------------- network/tunnel --
  ipcMain.handle(`${M}:network:upnp`, wrap(({ port, description }) => upnp.forward(port, description)));
  ipcMain.handle(`${M}:network:upnp:remove`, wrap(({ port }) => upnp.remove(port)));
  ipcMain.handle(`${M}:tunnel:status`, wrap(({ id }) => tunnel.status(id)));
  ipcMain.handle(`${M}:tunnel:start`, wrap(async ({ id }) => {
    const info = await tunnel.start(manager, id);
    const rt = manager._runtimeFor(id);
    rt.tunnelInfo = info;
    return info;
  }));
  ipcMain.handle(`${M}:tunnel:stop`, wrap(({ id }) => tunnel.stop(id)));

  // ------------------------------------------------------------- java -----
  ipcMain.handle(`${M}:java:installed`, wrap(() => javaruntime.installed()));
  ipcMain.handle(`${M}:java:provision`, wrap(({ feature, kind = 'jre' }) => javaruntime.ensure(feature, { kind })));

  // ---------------------------------------------------------- licensing ---
  ipcMain.handle(`${M}:license:status`, wrap(() => license.status()));
  ipcMain.handle(`${M}:license:activate`, wrap(({ key, label }) => license.activate(key, { label })));
  ipcMain.handle(`${M}:license:deactivate`, wrap(({ key }) => license.deactivate(key)));

  // --------------------------------------------------------- monetisation --
  ipcMain.handle(`${M}:monetize:info`, wrap(() => monetize.info()));
  ipcMain.handle(`${M}:monetize:suggest`, wrap(() => {
    const list = manager.listInstances();
    return monetize.suggestUpsell({
      instanceCount: list.length,
      onlineCount: list.filter((i) => i.runtime && i.runtime.state === 'online').length
    });
  }));
  ipcMain.handle(`${M}:monetize:dismiss`, wrap(({ kind }) => monetize.dismiss(kind)));

  // ------------------------------------------------------------- i18n -----
  ipcMain.handle(`${M}:i18n:list`, wrap(() => {
    const dirsToScan = [BUNDLED_LOCALES, getDirs().locales];
    const out = [];
    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const code = f.replace(/\.json$/, '');
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* ignore */ }
        out.push({
          code,
          name: (meta._meta && meta._meta.name) || code,
          source: dir === BUNDLED_LOCALES ? 'bundled' : 'user',
          path: path.join(dir, f),
          completeness: 0
        });
      }
    }
    const byCode = new Map();
    for (const e of out) {
      if (!byCode.has(e.code) || e.source === 'user') byCode.set(e.code, e);
    }
    return [...byCode.values()];
  }));
  ipcMain.handle(`${M}:i18n:get`, wrap(({ code = 'en' }) => {
    const user = path.join(getDirs().locales, `${code}.json`);
    const bundled = path.join(BUNDLED_LOCALES, `${code}.json`);
    const file = fs.existsSync(user) ? user : bundled;
    if (!fs.existsSync(file)) throw new Error(`No translation file for "${code}"`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }));
  ipcMain.handle(`${M}:i18n:export`, wrap(async ({ code = 'en' }) => {
    const src = path.join(BUNDLED_LOCALES, `${code}.json`);
    const res = await dialog.showSaveDialog(getWindow(), {
      defaultPath: `${code}-translation-template.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled) return null;
    fs.copyFileSync(src, res.filePath);
    return res.filePath;
  }));
  ipcMain.handle(`${M}:i18n:import`, wrap(async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const code = (json._meta && json._meta.code) || path.basename(file).replace(/\.json$/, '');
    const target = path.join(getDirs().locales, `${code}.json`);
    fs.copyFileSync(file, target);
    return { code, path: target };
  }));

  log.info('ipc handlers registered');
  return true;
}

module.exports = { register };
