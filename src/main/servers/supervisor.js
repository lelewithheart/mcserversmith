'use strict';
/**
 * ProcessSupervisor — owns exactly one Minecraft server process.
 *
 * Responsibilities
 *  - spawn the JVM (jar mode) or the generated run script (Forge/NeoForge)
 *  - stream stdout/stderr as parsed log events, tee to logs/latest.log
 *  - detect "Done (x.xxxs)!" -> online
 *  - graceful `stop` with timeout, then kill the whole process tree
 *  - detect UnsupportedClassVersionError and escalate to a newer Java once
 */
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { createLogger } = require('../core/util');
const { makeLineSplitter } = require('./logparse');
const jvm = require('./jvm');
const javaruntime = require('../java/runtime');

const log = createLogger('supervisor');

const READY_TIMEOUT_MS = 10 * 60 * 1000;
const GRACEFUL_STOP_MS = 60000;

class ProcessSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.meta      instance metadata
   * @param {string} opts.serverDir working directory of the server
   * @param {string} opts.logFile   console log destination
   * @param {string} opts.javaPath  java executable
   * @param {object} opts.launch    { mode:'jar', jar } | { mode:'script' }
   */
  constructor({ meta, serverDir, logFile, javaPath, launch }) {
    super();
    this.meta = meta;
    this.serverDir = serverDir;
    this.logFile = logFile;
    this.javaPath = javaPath;
    this.launch = launch;
    this.child = null;
    this.state = 'offline';
    this.startedAt = null;
    this.readyAt = null;
    this.exitCode = null;
    this.stopRequested = false;
    this.escalations = 0;
    this.ring = [];
    this.lastLines = [];
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }

  get online() {
    return this.state === 'online' || this.state === 'starting' || this.state === 'stopping';
  }

  /**
   * Environment for the child process.
   *
   * Critical for the Forge/NeoForge "script mode": run.bat / run.sh invoke a bare
   * `java`, which resolves through PATH — i.e. whatever the user happens to have
   * installed. A system Java 8 does not understand the `@user_jvm_args.txt`
   * argument-file syntax and dies with "Could not find or load main class
   * @user_jvm_args.txt". So we put OUR provisioned JVM first on PATH and point
   * JAVA_HOME at it.
   */
  _childEnv() {
    const javaDir = path.dirname(this.javaPath);
    const javaHome = path.dirname(javaDir);
    const env = { ...process.env };
    env.PATH = `${javaDir}${path.delimiter}${env.PATH || ''}`;
    env.JAVA_HOME = javaHome;
    return env;
  }

  /**
   * Forge/NeoForge ship `run.bat` / `run.sh`, which just do:
   *     java @user_jvm_args.txt @libraries/.../win_args.txt %*
   *
   * Running those scripts directly has two problems:
   *   1. the bare `java` resolves through PATH, i.e. whatever the user has —
   *      a system Java 8 does not understand `@argfile` and dies with
   *      "Could not find or load main class @user_jvm_args.txt";
   *   2. `run.bat` ends with `pause`, so the wrapper lingers after the server
   *      has exited and blocks a clean shutdown.
   *
   * So we read the argument files the script references and launch OUR JVM
   * directly with them. The script stays as the fallback.
   */
  _scriptArgs() {
    const candidates = process.platform === 'win32'
      ? [path.join(this.serverDir, 'run.bat'), path.join(this.serverDir, 'run.sh')]
      : [path.join(this.serverDir, 'run.sh'), path.join(this.serverDir, 'run.bat')];
    for (const script of candidates) {
      if (!fs.existsSync(script)) continue;
      let text = '';
      try { text = fs.readFileSync(script, 'utf8'); } catch { continue; }
      const found = [];
      for (const m of text.matchAll(/@([\w./\\:-]+\.txt)/g)) {
        const token = m[1];
        if (found.includes(token)) continue;
        if (fs.existsSync(path.join(this.serverDir, token))) found.push(token);
      }
      // user_jvm_args must come first (it is prepended to the java call)
      found.sort((a, b) => (a.includes('user_jvm_args') ? -1 : b.includes('user_jvm_args') ? 1 : 0));
      if (found.length) return found;
    }
    return null;
  }

  _buildCommand() {
    const { memoryMB, jvmArgs } = this.meta;
    if (this.launch.mode === 'script') {
      const args = this._scriptArgs();
      if (args) {
        return { cmd: this.javaPath, args: [...args.map((a) => `@${a}`), 'nogui'], viaArgsFiles: true };
      }
      // fallback: run the generated script (PATH and JAVA_HOME are fixed in _childEnv)
      const runBat = path.join(this.serverDir, 'run.bat');
      const runSh = path.join(this.serverDir, 'run.sh');
      if (process.platform === 'win32' && fs.existsSync(runBat)) {
        return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/c', 'run.bat', 'nogui'] };
      }
      if (fs.existsSync(runSh)) {
        return { cmd: '/bin/sh', args: ['run.sh', 'nogui'] };
      }
      if (fs.existsSync(runBat)) {
        return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/c', 'run.bat', 'nogui'] };
      }
      throw new Error('No run script found — reinstall the server.');
    }
    const jar = this.launch.jar || 'server.jar';
    if (!fs.existsSync(path.join(this.serverDir, jar))) {
      throw new Error(`Server jar ${jar} is missing — reinstall this server.`);
    }
    return {
      cmd: this.javaPath,
      args: [...jvm.jarFlags({ memoryMB, jvmArgs }), '-jar', jar, 'nogui']
    };
  }

  async start({ autoRestart = false } = {}) {
    if (this.child) throw new Error('Server is already running');
    const { cmd, args } = this._buildCommand();

    if (!fs.existsSync(path.dirname(this.logFile))) {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    }
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.logStream.write(`\n===== start ${new Date().toISOString()} =====\n`);

    const cmdLine = `${cmd} ${args.join(' ')}`;
    this._emitLog({ line: `> ${cmdLine}`, level: 'system', event: null });

    this.stopRequested = false;
    this.exitCode = null;
    this.readyAt = null;
    this.escalations = 0;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.emit('state', this.state);

    const spawnOpts = {
      cwd: this.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this._childEnv()
    };
    if (process.platform !== 'win32') spawnOpts.detached = true;   // own process group -> killpg

    try {
      this.child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      this.state = 'crashed';
      this.lastError = err.message;
      this.emit('state', this.state);
      throw err;
    }

    const splitOut = makeLineSplitter();
    const splitErr = makeLineSplitter();

    this.child.stdout.on('data', (chunk) => {
      for (const entry of splitOut(chunk)) this._emitLog(entry);
    });
    this.child.stderr.on('data', (chunk) => {
      for (const entry of splitErr(chunk)) this._emitLog(entry);
    });

    this.child.on('error', (err) => {
      this._emitLog({ line: `spawn error: ${err.message}`, level: 'error', event: null });
    });

    this.child.on('close', (code, signal) => {
      this.exitCode = code;
      this.child = null;
      const wasStopping = this.stopRequested;
      if (this.logStream) { this.logStream.end(); this.logStream = null; }

      if (wasStopping) {
        this.state = 'offline';
      } else if (code === 0) {
        this.state = 'offline';
      } else {
        this.state = 'crashed';
        this._emitLog({
          line: `Server process exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''}).`,
          level: 'error',
          event: { type: 'crash', data: { code, signal } }
        });
      }
      const uptime = this.startedAt ? Date.now() - this.startedAt : 0;
      this.emit('exit', { code, signal, uptime, wasStopping });
      this.emit('state', this.state);
    });

    this.emit('started', { pid: this.child.pid, cmdLine });
    return this.child.pid;
  }

  _emitLog(entry) {
    this.ring.push(entry);
    if (this.ring.length > 2000) this.ring.shift();
    this.lastLines.push(entry.line);
    if (this.lastLines.length > 40) this.lastLines.shift();
    if (this.logStream) {
      try { this.logStream.write(`${entry.line}\n`); } catch { /* ignore */ }
    }
    this.emit('log', entry);

    const ev = entry.event;
    if (!ev) return;

    if (ev.type === 'ready') {
      this.readyAt = Date.now();
      this.state = 'online';
      this.emit('state', this.state);
      this.emit('ready', ev.data);
    } else if (ev.type === 'join' || ev.type === 'leave') {
      this.emit('player', ev);
    } else if (ev.type === 'tps') {
      this.emit('tps', ev.data.tps);
    } else if (ev.type === 'javaTooOld') {
      this.emit('javaTooOld', ev.data);
    } else if (ev.type === 'eula') {
      this.emit('needsEula', ev.data);
    } else {
      this.emit('event', ev);
    }
  }

  /** Send a console command (without trailing newline). */
  command(cmd) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error('Server is not running');
    }
    this.child.stdin.write(`${String(cmd).replace(/\r?\n$/, '')}\n`);
    this._emitLog({ line: `> ${cmd}`, level: 'system', event: null });
    return true;
  }

  /** Graceful stop: `stop` on stdin, then kill the tree after the timeout. */
  async stop({ timeoutMs = GRACEFUL_STOP_MS } = {}) {
    if (!this.child) return true;
    this.stopRequested = true;
    this.state = 'stopping';
    this.emit('state', this.state);
    try {
      this.command('stop');
    } catch {
      return this.kill();
    }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      this._emitLog({
        line: `Server did not stop within ${Math.round(timeoutMs / 1000)}s — forcing shutdown.`,
        level: 'warn',
        event: null
      });
      return this.kill();
    }
    return true;
  }

  /** Hard kill of the entire process tree. */
  async kill() {
    const child = this.child;
    if (!child) return true;
    this.stopRequested = true;
    const pid = child.pid;
    this._emitLog({ line: `Forcing shutdown (pid ${pid})…`, level: 'warn', event: null });

    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
      try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    const gone = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      if (!this.child) { clearTimeout(timer); resolve(true); return; }
      this.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!gone) this._emitLog({ line: 'Process may still be alive — check your task manager.', level: 'error', event: null });
    return gone;
  }

  /** Escalate to a newer Java after UnsupportedClassVersionError. */
  async escalateJava() {
    const next = javaruntime.nextFeature(this.meta.javaFeature || 21);
    if (!next || this.escalations >= 2) return null;
    this.escalations += 1;
    this._emitLog({
      line: `This server needs a newer Java. Installing Java ${next} and retrying…`,
      level: 'warn',
      event: null
    });
    const java = await javaruntime.ensure(next, { kind: this.meta.javaKind || 'jre' });
    this.javaPath = java.javaPath;
    this.meta.javaFeature = next;
    return java;
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      exitCode: this.exitCode,
      lastError: this.lastError || null
    };
  }

  consoleTail(limit = 300) {
    return this.ring.slice(Math.max(0, this.ring.length - limit));
  }
}

module.exports = { ProcessSupervisor, READY_TIMEOUT_MS };
