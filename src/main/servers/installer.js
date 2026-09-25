'use strict';
/**
 * Install pipeline for an instance: resolve artifact -> provision Java ->
 * download -> (installer|buildtools|plain jar) -> configure -> ready.
 *
 * Progress is reported through callbacks so the UI can show a real progress bar
 * instead of a spinner:
 *   onProgress({ phase, percent, message, detail })
 *   onLog(line)                 — raw output from installers (shown in console)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDirs } = require('../core/paths');
const {
  ensureDir, exists, isFile, rmrf, copyRecursive, createLogger, humanBytes
} = require('../core/util');
const { download } = require('../core/http');
const javaruntime = require('../java/runtime');
const instances = require('./instances');
const providerRegistry = require('../providers');
const props = require('./props');
const jvm = require('./jvm');

const log = createLogger('installer');

function emit(onProgress, phase, percent, message, detail) {
  if (onProgress) {
    try { onProgress({ phase, percent, message, detail }); } catch { /* ignore */ }
  }
}

/** Run a JVM program (installer / buildtools) streaming its output. */
function runJavaStep(javaPath, args, { cwd, onLog, timeoutMs = 45 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    let tail = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`Installer timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    const handle = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/\u001b\[[0-9;]*m/g, '');
        if (!clean.trim()) continue;
        tail.push(clean);
        if (tail.length > 60) tail.shift();
        if (onLog) onLog(clean);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, tail });
      else reject(new Error(`Installer exited with code ${code}:\n${tail.slice(-8).join('\n')}`));
    });
  });
}

async function fetchArtifactToCache(artifact, onProgress, onLog) {
  const { cache } = getDirs();
  const safeName = artifact.filename.replace(/[/\\]/g, '_');
  const dest = path.join(cache, safeName);
  if (onLog) onLog(`Downloading ${artifact.url}`);
  const res = await download(artifact.url, dest, {
    hashes: artifact.hashes,
    onProgress: (p) => {
      const speed = p.bytesPerSecond ? ` (${humanBytes(p.bytesPerSecond)}/s)` : '';
      emit(onProgress, 'download', p.cached ? 100 : (p.percent || 0), p.cached
        ? `Using cached ${safeName}`
        : `Downloading ${safeName} — ${p.percent == null ? humanBytes(p.received) : `${p.percent}%`}${speed}`);
    }
  });
  if (onLog) onLog(`Downloaded ${safeName} (${humanBytes(res.bytes)})`);
  return res.path;
}

/**
 * @param {object} meta instance metadata (from instances.create)
 * @returns {Promise<object>} updated meta
 */
async function install(meta, { onProgress = null, onLog = null, experimental = false } = {}) {
  const p = instances.instancePaths(meta.id);
  instances.createDirs(meta.id);

  const provider = providerRegistry.get(meta.provider);
  const jobId = `${meta.id}`;
  log.info(`installing ${jobId}: ${meta.provider} ${meta.mcVersion}`);

  try {
    // 1. resolve -----------------------------------------------------------
    emit(onProgress, 'resolve', 2, `Resolving ${provider.label} ${meta.mcVersion}…`);
    const artifact = await provider.resolve({
      mcVersion: meta.mcVersion,
      loaderVersion: meta.loaderVersion,
      experimental
    });
    if (onLog) onLog(`Resolved: ${artifact.notes || artifact.filename}`);

    // 2. download artifact -------------------------------------------------
    emit(onProgress, 'download', 8, 'Downloading server files…');
    const artifactPath = await fetchArtifactToCache(artifact, onProgress, onLog);

    // 3. Java --------------------------------------------------------------
    const javaInfo = javaruntime.requiredJava({
      jarPath: artifact.mode === 'jar' ? artifactPath : null,
      mcVersion: meta.mcVersion
    });
    const javaKind = artifact.mode === 'buildtools' ? 'jdk' : 'jre';
    emit(onProgress, 'java', 35, `Preparing Java ${javaInfo.feature} (${javaInfo.source})…`);
    const java = await javaruntime.ensure(javaInfo.feature, {
      kind: javaKind,
      onProgress: (pr) => emit(onProgress, 'java', 35 + Math.round((pr.percent || 0) * 0.12),
        `Downloading Java ${javaInfo.feature}… ${pr.percent == null ? '' : `${pr.percent}%`}`)
    });
    if (onLog) onLog(`Java ready: ${java.javaPath} (feature ${java.feature}, ${java.cached ? 'cached' : 'freshly installed'})`);

    // 4. place + install ---------------------------------------------------
    let launch = artifact.launch || { mode: 'jar', jar: 'server.jar' };

    if (artifact.mode === 'jar') {
      emit(onProgress, 'install', 50, 'Installing server jar…');
      const target = path.join(p.server, launch.jar || 'server.jar');
      rmrf(target);
      fs.copyFileSync(artifactPath, target);
      if (onLog) onLog(`Installed ${path.basename(target)}`);
    } else if (artifact.mode === 'installer') {
      emit(onProgress, 'install', 50, 'Running the official installer (this can take a few minutes)…');
      const installerJar = path.join(p.server, artifact.filename);
      fs.copyFileSync(artifactPath, installerJar);
      // Forge/NeoForge want: java -jar installer.jar --installServer
      const launchArgs = ['-jar', installerJar, ...(artifact.installArgs || ['--installServer'])];
      await runJavaStep(java.javaPath, launchArgs, { cwd: p.server, onLog });
      emit(onProgress, 'install', 78, 'Installer finished, preparing launch files…');
      launch = await resolveLaunchAfterInstall(meta, p, launch);
    } else if (artifact.mode === 'buildtools') {
      emit(onProgress, 'install', 50, 'Compiling Spigot with BuildTools — this takes 5-30 minutes…');
      const work = path.join(p.dir, 'buildtools');
      ensureDir(work);
      const toolsJar = path.join(work, 'BuildTools.jar');
      fs.copyFileSync(artifactPath, toolsJar);
      const git = require('../core/util').which('git');
      if (!git) throw new Error('BuildTools needs git, but git was not found on PATH. Install git or use Paper instead.');
      await runJavaStep(java.javaPath, ['-jar', toolsJar, ...(artifact.buildArgs || [])], { cwd: work, onLog });
      const produced = fs.readdirSync(work).filter((f) => /^spigot-.*\.jar$/.test(f));
      if (!produced.length) throw new Error('BuildTools finished but produced no spigot jar');
      const spigot = path.join(work, produced[0]);
      const target = path.join(p.server, launch.jar || produced[0]);
      fs.copyFileSync(spigot, target);
      if (onLog) onLog(`Installed ${produced[0]} (${humanBytes(fs.statSync(target).size)})`);
      rmrf(work);
    }

    // 5. configure ---------------------------------------------------------
    emit(onProgress, 'configure', 88, 'Writing configuration…');
    const finalJava = javaruntime.requiredJava({
      jarPath: launch.mode === 'jar' && launch.jar ? path.join(p.server, launch.jar) : null,
      mcVersion: meta.mcVersion,
      providerMin: javaInfo.feature
    });

    if (launch.mode === 'script') {
      // memory lives in user_jvm_args.txt — command line flags are ignored
      fs.writeFileSync(p.userJvmArgs, jvm.userJvmArgsFile({
        memoryMB: meta.memoryMB,
        jvmArgs: meta.jvmArgs
      }));
      if (process.platform !== 'win32' && isFile(p.runSh)) {
        try { fs.chmodSync(p.runSh, 0o755); } catch { /* ignore */ }
      }
      if (!isFile(p.runSh) && !isFile(p.runBat)) {
        throw new Error('Installer produced neither run.sh nor run.bat');
      }
    }

    // server.properties: refresh the values the launcher owns
    props.writeProperties(p.properties, {
      'server-port': meta.port,
      motd: meta.motd,
      'max-players': meta.maxPlayers,
      difficulty: meta.difficulty,
      gamemode: meta.gamemode,
      'online-mode': meta.onlineMode ? 'true' : 'false',
      'view-distance': meta.viewDistance,
      'rcon.port': meta.rconPort,
      'rcon.password': meta.rconPassword,
      'enable-rcon': 'true'
    });

    fs.writeFileSync(p.eula, `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=${meta.eulaAccepted ? 'true' : 'false'}\n`);

    // 6. manifest (reproducibility) ---------------------------------------
    const manifest = {
      generatedAt: new Date().toISOString(),
      provider: meta.provider,
      mcVersion: meta.mcVersion,
      loaderVersion: meta.loaderVersion,
      artifact: {
        url: artifact.url,
        filename: artifact.filename,
        hashes: artifact.hashes,
        mode: artifact.mode,
        notes: artifact.notes || null,
        buildId: artifact.buildId || null,
        channel: artifact.channel || null
      },
      java: { feature: finalJava.feature, source: finalJava.source, kind: javaKind },
      launch
    };
    instances.writeManifest(meta.id, manifest);

    const updated = instances.update(meta.id, {
      launch,
      artifact: manifest.artifact,
      javaFeature: finalJava.feature,
      javaKind,
      installed: true,
      installState: 'ready',
      lastError: null
    });

    emit(onProgress, 'done', 100, 'Ready to start');
    if (onLog) onLog('Installation complete.');
    log.info(`installed ${meta.id} (${meta.provider} ${meta.mcVersion}, Java ${finalJava.feature}, ${launch.mode})`);
    return updated;
  } catch (err) {
    log.error(`install failed for ${meta.id}: ${err.message}`);
    instances.update(meta.id, { installState: 'failed', lastError: err.message });
    throw err;
  }
}

/** Forge/NeoForge produce run scripts; Fabric produces a launcher jar. */
async function resolveLaunchAfterInstall(meta, p, launchHint) {
  if (launchHint && launchHint.mode === 'jar' && launchHint.jar) {
    const jarPath = path.join(p.server, launchHint.jar);
    if (isFile(jarPath)) return launchHint;
    // some fabric builds name it differently — pick the first server launcher jar
    const candidates = fs.readdirSync(p.server).filter((f) => /^fabric-server.*\.jar$/.test(f));
    if (candidates.length) return { mode: 'jar', jar: candidates[0] };
    throw new Error(`Expected ${launchHint.jar} after install but it is missing`);
  }
  if (isFile(p.runBat) || isFile(p.runSh)) return { mode: 'script' };
  const serverJars = fs.readdirSync(p.server).filter((f) => /^server\.jar$/.test(f));
  if (serverJars.length) return { mode: 'jar', jar: 'server.jar' };
  throw new Error('Could not determine how to launch this server after install');
}

module.exports = { install, runJavaStep };
