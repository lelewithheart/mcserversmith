'use strict';
/**
 * ServerManager — the single backend facade used by the IPC layer and by the
 * headless test harness. Owns instances, supervisors, status polling and all
 * "one click" actions.
 *
 * Everything the UI needs is exposed as plain data and pushed through a single
 * 'event' channel: { type, id, payload }.
 */
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { getDirs, setDataRoot, ensureDirs } = require('../core/paths');
const { createLogger, dirSize, humanBytes, exists } = require('../core/util');
const settings = require('../core/settings');
const providerRegistry = require('../providers');
const instances = require('./instances');
const installer = require('./installer');
const { ProcessSupervisor } = require('./supervisor');
const { MetricsSampler } = require('./metrics');
const slp = require('./slp');
const rcon = require('./rcon');
const props = require('./props');
const backup = require('./backup');
const scheduler = require('./scheduler');
const plugins = require('./plugins');
const upnp = require('./upnp');
const tunnel = require('../net/tunnel');
const license = require('../licensing/license');
const monetize = require('../licensing/monetize');

const log = createLogger('manager');

const POLL_FAST_MS = 3000;
const POLL_SLP_MS = 5000;
const POLL_RCON_MS = 20000;
const POLL_WORLD_MS = 60000;
const POLL_NET_MS = 60000;

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.runtime = new Map();
    this.publicIp = null;
    this.publicIpAt = 0;
    this.pollTimer = null;
  }

  init({ dataRoot = null } = {}) {
    if (dataRoot) setDataRoot(dataRoot);
    ensureDirs();
    settings.load();
    for (const meta of instances.list()) {
      this._runtimeFor(meta.id, meta);
    }
    this._startPolling();
    scheduler.init(this);
    log.info(`manager ready — ${instances.list().length} instance(s) in ${getDirs().root}`);
    return this;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------
  _runtimeFor(id, metaOverride = null) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        supervisor: null,
        install: null,
        slp: null,
        players: { online: 0, max: 0, names: [] },
        metrics: { rssBytes: null, cpuPercent: null },
        metricsSampler: null,
        worldSizeBytes: null,
        worldSizeAt: 0,
        lastSlpAt: 0,
        lastRconAt: 0,
        restarts: [],
        joinAddress: null
      });
    }
    const rt = this.runtime.get(id);
    if (metaOverride && !rt.meta) rt.meta = metaOverride;
    return rt;
  }

  _emit(type, id, payload) {
    try { this.emit('event', { type, id, payload }); } catch (err) { log.warn(`event listener failed: ${err.message}`); }
  }

  _log(id, line) {
    this._emit('log', id, { line, level: 'system', event: null });
  }

  _network() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
      }
    }
    return out;
  }

  async _fetchPublicIp() {
    if (this.publicIp && Date.now() - this.publicIpAt < POLL_NET_MS) return this.publicIp;
    try {
      const { fetchText } = require('../core/http');
      const ip = (await fetchText('https://api.ipify.org', { timeout: 8000 })).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        this.publicIp = ip;
        this.publicIpAt = Date.now();
      }
    } catch (err) {
      log.warn(`public ip lookup failed: ${err.message}`);
    }
    return this.publicIp;
  }

  // -------------------------------------------------------------------------
  // instances
  // -------------------------------------------------------------------------
  listInstances() {
    const metas = instances.list();
    const out = metas.map((m) => ({ ...m, runtime: this._snapshotRuntime(m.id) }));
    // instances created in this session but not yet written? (they are written immediately)
    return out;
  }

  getInstance(id) {
    return instances.read(id);
  }

  createInstance(opts) {
    if (!providerRegistry.has(opts.provider)) throw new Error(`Unknown server type ${opts.provider}`);
    const provider = providerRegistry.get(opts.provider);
    if (provider.advanced && !opts.confirmedAdvanced) {
      const err = new Error('This server type needs explicit confirmation');
      err.code = 'NEEDS_CONFIRMATION';
      err.warnings = provider.warnings || [];
      throw err;
    }
    const meta = instances.create({ ...opts, kind: provider.kind });
    this._runtimeFor(meta.id, meta);
    this._emit('created', meta.id, meta);
    log.info(`created instance ${meta.id} (${meta.provider} ${meta.mcVersion})`);
    return meta;
  }

  async installInstance(id, { experimental = false } = {}) {
    const meta = instances.read(id);
    const rt = this._runtimeFor(id, meta);
    if (rt.install) throw new Error('Installation already running');

    const job = installer.install(meta, {
      experimental,
      onProgress: (p) => {
        rt.install = p;
        this._emit('progress', id, p);
      },
      onLog: (line) => this._emit('log', id, { line, level: 'plain', event: { type: 'installer' } })
    });

    rt.install = { phase: 'resolve', percent: 0, message: 'Starting installer…' };
    try {
      const updated = await job;
      rt.install = null;
      this._emit('progress', id, { phase: 'done', percent: 100, message: 'Ready to start' });
      this._emit('updated', id, updated);
      return updated;
    } catch (err) {
      rt.install = null;
      this._emit('progress', id, { phase: 'error', percent: 0, message: err.message });
      this._emit('error', id, { message: err.message, where: 'install' });
      throw err;
    }
  }

  updateInstance(id, patch) {
    const allowed = [
      'name', 'memoryMB', 'jvmArgs', 'port', 'rconPort', 'motd', 'maxPlayers',
      'difficulty', 'gamemode', 'onlineMode', 'viewDistance', 'autoRestart',
      'scheduledRestart', 'scheduleRestarts', 'backup', 'tunnel'
    ];
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) clean[k] = v;
    const meta = instances.update(id, clean);

    // keep server.properties in sync for the fields the launcher owns
    const p = instances.instancePaths(id);
    const propPatch = {};
    if (clean.port !== undefined) propPatch['server-port'] = clean.port;
    if (clean.motd !== undefined) propPatch.motd = clean.motd;
    if (clean.maxPlayers !== undefined) propPatch['max-players'] = clean.maxPlayers;
    if (clean.difficulty !== undefined) propPatch.difficulty = clean.difficulty;
    if (clean.gamemode !== undefined) propPatch.gamemode = clean.gamemode;
    if (clean.onlineMode !== undefined) propPatch['online-mode'] = clean.onlineMode ? 'true' : 'false';
    if (clean.viewDistance !== undefined) propPatch['view-distance'] = clean.viewDistance;
    if (clean.rconPort !== undefined) propPatch['rcon.port'] = clean.rconPort;
    if (Object.keys(propPatch).length && exists(p.properties)) props.writeProperties(p.properties, propPatch);

    if (clean.memoryMB !== undefined && meta.launch && meta.launch.mode === 'script') {
      const jvm = require('./jvm');
      fs.writeFileSync(p.userJvmArgs, jvm.userJvmArgsFile({ memoryMB: meta.memoryMB, jvmArgs: meta.jvmArgs }));
    }

    this._emit('updated', id, meta);
    return meta;
  }

  setEula(id, accepted) {
    const meta = instances.setEula(id, accepted);
    settings.set({ acceptEula: !!accepted, eulaAcceptedAt: accepted ? new Date().toISOString() : null });
    this._emit('updated', id, meta);
    return meta;
  }

  async deleteInstance(id, { deleteFiles = true } = {}) {
    const rt = this.runtime.get(id);
    if (rt && rt.supervisor && rt.supervisor.online) await this.stopInstance(id, { force: true });
    if (rt) {
      if (rt.supervisor) rt.supervisor.removeAllListeners();
      try { await tunnel.stop(id); } catch { /* ignore */ }
      this.runtime.delete(id);
    }
    if (deleteFiles) instances.remove(id);
    this._emit('deleted', id, { deleteFiles });
    log.info(`deleted instance ${id} (files=${deleteFiles})`);
    return true;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  async startInstance(id) {
    const meta = instances.read(id);
    const rt = this._runtimeFor(id, meta);

    if (rt.supervisor && rt.supervisor.online) throw new Error('Server is already running');
    if (!meta.installed) throw new Error('Server is not installed yet — run the installer first');

    const p = instances.instancePaths(id);
    if (!meta.eulaAccepted) {
      const err = new Error('The Minecraft EULA must be accepted before the first start');
      err.code = 'NEEDS_EULA';
      throw err;
    }
    fs.writeFileSync(p.eula, '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=true\n');

    const java = require('../java/runtime');
    const javaPath = java.javaBinary(meta.javaFeature, meta.javaKind || 'jre');
    if (!javaPath) throw new Error(`Java ${meta.javaFeature} is missing — reinstall this server`);

    const sup = new ProcessSupervisor({
      meta,
      serverDir: p.server,
      logFile: p.latestLog,
      javaPath,
      launch: meta.launch
    });
    rt.supervisor = sup;
    rt.metricsSampler = new MetricsSampler(null);

    sup.on('log', (entry) => this._emit('log', id, entry));
    sup.on('state', (state) => {
      if (state === 'online' || state === 'crashed' || state === 'offline') rt.restarts = rt.restarts || [];
      this._emit('state', id, { state, pid: sup.pid, startedAt: sup.startedAt });
    });
    sup.on('player', (ev) => this._emit('playerevent', id, ev));
    sup.on('tps', (tps) => { rt.tps = tps; this._emit('status', id, this.status(id)); });
    sup.on('javaTooOld', () => this._handleJavaEscalation(id, sup));
    sup.on('needsEula', () => this._emit('error', id, { message: 'The EULA needs to be accepted (eula.txt)', where: 'eula' }));
    sup.on('exit', (info) => this._onSupervisorExit(id, sup, info));
    sup.on('ready', () => {
      // the previous ping may predate the listening socket — refresh right away
      // so the dashboard never shows stale "not queryable" data after startup
      rt.lastSlpAt = 0;
      rt.lastRconAt = 0;
      this._emit('status', id, this.status(id));
      setTimeout(() => {
        this._tick().catch(() => {});
        this.status(id).then((s) => this._emit('status', id, s)).catch(() => {});
      }, 1200);
      this._bootstrapTunnel(id);
    });

    const pid = await sup.start();

    instances.update(id, {
      stats: {
        ...meta.stats,
        totalStarts: (meta.stats && meta.stats.totalStarts ? meta.stats.totalStarts : 0) + 1,
        lastStartedAt: new Date().toISOString(),
        totalPlaytimeMs: (meta.stats && meta.stats.totalPlaytimeMs) || 0
      }
    });
    settings.set({ instanceCountStarted: (settings.get('instanceCountStarted', 0) || 0) + 1 });
    monetize.noteServerStart(this);

    this._emit('state', id, { state: 'starting', pid, startedAt: Date.now() });
    return { pid };
  }

  async _handleJavaEscalation(id, sup) {
    try {
      const java = await sup.escalateJava();
      if (!java) {
        this._emit('error', id, {
          message: 'This server needs a newer Java version than MCServerSmith can provide. Please report this.',
          where: 'java'
        });
        return;
      }
      instances.update(id, { javaFeature: java.feature });
      this._emit('log', id, { line: `Retrying with Java ${java.feature}…`, level: 'warn', event: null });
      // restart with the new JVM
      await sup.stop({ timeoutMs: 8000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      await this.startInstance(id);
    } catch (err) {
      this._emit('error', id, { message: `Java escalation failed: ${err.message}`, where: 'java' });
    }
  }

  _onSupervisorExit(id, sup, info) {
    const meta = instances.read(id);
    if (meta && meta.stats) {
      instances.update(id, {
        stats: { ...meta.stats, totalPlaytimeMs: (meta.stats.totalPlaytimeMs || 0) + info.uptime }
      });
    }
    try { tunnel.stop(id).catch(() => {}); } catch { /* ignore */ }

    if (info.wasStopping) return;
    const rt = this._runtimeFor(id);

    // automatic crash recovery (supporter)
    if (info.code !== 0 && meta.autoRestart) {
      if (!license.hasFeature('autoRestart')) {
        this._emit('error', id, {
          message: 'Auto-restart is a supporter feature. The server crashed and will not be restarted automatically.',
          where: 'license',
          upsell: 'autoRestart'
        });
        return;
      }
      const now = Date.now();
      rt.restarts = (rt.restarts || []).filter((t) => now - t < 60 * 60 * 1000);
      if (rt.restarts.length >= 5) {
        this._emit('error', id, { message: 'Crash loop detected (5 restarts in an hour) — auto-restart disabled.', where: 'crashloop' });
        return;
      }
      rt.restarts.push(now);
      this._emit('log', id, { line: 'Auto-restarting in 10 seconds…', level: 'warn', event: null });
      setTimeout(() => {
        this.startInstance(id).catch((err) => this._emit('error', id, { message: err.message, where: 'autorestart' }));
      }, 10000);
    }
  }

  async stopInstance(id, { force = false } = {}) {
    const rt = this._runtimeFor(id);
    const sup = rt.supervisor;
    if (!sup || !sup.child) return true;
    try { await tunnel.stop(id); } catch { /* ignore */ }
    if (force) return sup.kill();
    return sup.stop();
  }

  async killInstance(id) {
    const rt = this._runtimeFor(id);
    if (!rt.supervisor) return true;
    return rt.supervisor.kill();
  }

  async restartInstance(id) {
    await this.stopInstance(id);
    await new Promise((r) => setTimeout(r, 1500));
    return this.startInstance(id);
  }

  sendCommand(id, command) {
    const rt = this._runtimeFor(id);
    if (!rt.supervisor) throw new Error('Server is not running');
    return rt.supervisor.command(command);
  }

  /** Console command via RCON (used for admin actions while still starting). */
  async rconCommand(id, command) {
    const meta = instances.read(id);
    return rcon.exec(
      { host: '127.0.0.1', port: meta.rconPort, password: meta.rconPassword },
      command
    );
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  _snapshotRuntime(id) {
    const rt = this.runtime.get(id);
    if (!rt) return { state: 'offline' };
    return {
      state: rt.supervisor ? rt.supervisor.state : 'offline',
      pid: rt.supervisor ? rt.supervisor.pid : null,
      startedAt: rt.supervisor ? rt.supervisor.startedAt : null,
      uptimeMs: rt.supervisor && rt.supervisor.startedAt ? Date.now() - rt.supervisor.startedAt : 0,
      install: rt.install,
      lastError: rt.supervisor ? rt.supervisor.lastError : null
    };
  }

  async status(id) {
    const meta = instances.read(id);
    const rt = this._runtimeFor(id, meta);
    const sup = rt.supervisor;

    const state = sup ? sup.state : 'offline';
    const isOnline = state === 'online';
    const port = meta.port;
    const local = this._network();
    const publicIp = await this._fetchPublicIp();

    let joinAddress = null;
    if (rt.tunnelInfo && rt.tunnelInfo.address) joinAddress = rt.tunnelInfo.address;
    else if (publicIp) joinAddress = `${publicIp}:${port}`;
    else if (local[0]) joinAddress = `${local[0].address}:${port}`;

    return {
      id,
      name: meta.name,
      provider: meta.provider,
      kind: meta.kind,
      mcVersion: meta.mcVersion,
      loaderVersion: meta.loaderVersion,
      state,
      pid: sup ? sup.pid : null,
      uptimeMs: sup && sup.startedAt ? Date.now() - sup.startedAt : 0,
      startedAt: sup ? sup.startedAt : null,
      install: rt.install,
      port,
      address: {
        local,
        port,
        publicIp,
        joinAddress,
        tunnel: rt.tunnelInfo || null
      },
      players: {
        online: rt.players.online,
        max: rt.players.max || meta.maxPlayers,
        names: rt.players.names,
        source: rt.players.source || null
      },
      server: {
        motd: rt.slp ? rt.slp.motd : meta.motd,
        versionName: rt.slp ? rt.slp.version : null,
        latencyMs: rt.slp ? rt.slp.latency : null,
        queryable: !!(rt.slp && rt.slp.online)
      },
      metrics: {
        ...rt.metrics,
        uptimeMs: sup && sup.startedAt ? Date.now() - sup.startedAt : 0
      },
      tps: rt.tps || null,
      worldSizeBytes: rt.worldSizeBytes,
      memoryMB: meta.memoryMB,
      eulaAccepted: meta.eulaAccepted,
      installed: meta.installed,
      lastError: (sup && sup.lastError) || meta.lastError || null,
      tunnel: meta.tunnel,
      backup: meta.backup,
      autoRestart: meta.autoRestart,
      jvm: { javaFeature: meta.javaFeature, javaKind: meta.javaKind },
      stats: meta.stats
    };
  }

  async statuses() {
    const out = [];
    for (const meta of instances.list()) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.status(meta.id));
    }
    return out;
  }

  getConsole(id, limit = 500) {
    const rt = this.runtime.get(id);
    if (!rt || !rt.supervisor) {
      // fall back to the persisted log tail
      const p = instances.instancePaths(id);
      try {
        const text = fs.readFileSync(p.latestLog, 'utf8');
        const lines = text.split(/\r?\n/).slice(-limit);
        return lines.map((line) => ({ line, level: 'plain', event: null, restored: true }));
      } catch { return []; }
    }
    return rt.supervisor.consoleTail(limit);
  }

  // -------------------------------------------------------------------------
  // polling
  // -------------------------------------------------------------------------
  _startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this._tick().catch((err) => log.warn(`poll tick failed: ${err.message}`));
    }, POLL_FAST_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  async _tick() {
    const now = Date.now();
    for (const meta of instances.list()) {
      const rt = this._runtimeFor(meta.id, meta);
      const sup = rt.supervisor;
      if (!sup || !sup.online) continue;

      // CPU / RAM
      if (sup.pid) {
        if (!rt.metricsSampler || rt.metricsSampler.pid !== sup.pid) rt.metricsSampler = new MetricsSampler(sup.pid);
        const m = await rt.metricsSampler.sample();
        if (m) {
          rt.metrics = m;
          this._emit('metrics', meta.id, m);
        }
      }

      // Server list ping (players / MOTD / latency)
      if (now - rt.lastSlpAt > POLL_SLP_MS) {
        rt.lastSlpAt = now;
        const res = await slp.ping('127.0.0.1', meta.port, { timeout: 4000 });
        rt.slp = res;
        if (res.online && res.players) {
          rt.players.online = res.players.online;
          rt.players.max = res.players.max;
          rt.players.source = 'ping';
          if (res.players.sample && res.players.sample.length) rt.players.names = res.players.sample;
          this._emit('players', meta.id, { ...rt.players });
        } else if (!res.online && sup.state === 'online') {
          rt.players.online = 0;
        }
      }

      // RCON: accurate names + TPS
      if (now - rt.lastRconAt > POLL_RCON_MS && sup.state === 'online') {
        rt.lastRconAt = now;
        try {
          const listOut = await rcon.exec({ host: '127.0.0.1', port: meta.rconPort, password: meta.rconPassword }, 'list');
          const parsed = rcon.parseListOutput(listOut);
          if (parsed.online != null) {
            rt.players.online = parsed.online;
            rt.players.max = parsed.max || rt.players.max;
            rt.players.names = parsed.players;
            rt.players.source = 'rcon';
            this._emit('players', meta.id, { ...rt.players });
          }
          const tpsOut = await rcon.exec({ host: '127.0.0.1', port: meta.rconPort, password: meta.rconPassword }, 'tps')
            .catch(() => null);
          const tps = rcon.parseTpsOutput(tpsOut);
          if (tps) rt.tps = tps;
        } catch { /* rcon may be off or still booting */ }
      }

      // world size on disk
      if (now - rt.worldSizeAt > POLL_WORLD_MS) {
        rt.worldSizeAt = now;
        const p = instances.instancePaths(meta.id);
        const worldDir = path.join(p.server, props.get(p.properties, 'level-name', 'world'));
        dirSize(worldDir).then((size) => { rt.worldSizeBytes = size; }).catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // tunnel
  // -------------------------------------------------------------------------
  async _bootstrapTunnel(id) {
    const meta = instances.read(id);
    if (!meta.tunnel || meta.tunnel.provider === 'none') {
      if (settings.get('autoPortForward', true) && !meta.tunnelAutoForwardFailed) {
        try {
          const rt = this._runtimeFor(id);
          const result = await upnp.forward(meta.port, `MCServerSmith ${meta.name}`);
          if (result && result.ok) {
            rt.tunnelInfo = { provider: 'upnp', address: result.address, externalIp: result.externalIp };
            this._log(id, `Automatic port forwarding succeeded: ${result.address}`);
            this._emit('status', id, await this.status(id));
          } else if (result && result.reason) {
            instances.update(id, { tunnelAutoForwardFailed: true });
            this._log(id, `Automatic port forwarding unavailable (${result.reason}). Players outside your network need a tunnel.`);
          }
        } catch (err) {
          log.warn(`upnp failed for ${id}: ${err.message}`);
        }
      }
      return;
    }

    try {
      const info = await tunnel.start(this, id);
      const rt = this._runtimeFor(id);
      rt.tunnelInfo = info;
      this._emit('status', id, await this.status(id));
    } catch (err) {
      this._emit('error', id, { message: `Tunnel failed: ${err.message}`, where: 'tunnel' });
    }
  }

  // -------------------------------------------------------------------------
  // misc
  // -------------------------------------------------------------------------
  async appInfo() {
    const pkg = require('../../../package.json');
    return {
      name: 'MCServerSmith',
      version: pkg.version,
      electron: process.versions.electron || null,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      dataRoot: getDirs().root,
      providers: providerRegistry.list(),
      settings: settings.all(),
      license: license.status(),
      monetize: monetize.info(this),
      network: {
        local: this._network(),
        publicIp: await this._fetchPublicIp()
      },
      java: require('../java/runtime').installed().map((j) => ({
        feature: j.feature, kind: j.kind, path: j.javaPath
      })),
      capabilities: {
        git: !!(require('../core/util').which('git')),
        tar: !!(require('../core/util').which('tar')),
        unzip: !!(require('../core/util').which('unzip'))
      }
    };
  }
}

module.exports = { ServerManager, POLL_FAST_MS };
