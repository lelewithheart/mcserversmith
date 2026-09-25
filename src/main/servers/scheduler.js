'use strict';
/**
 * Scheduler: nightly restarts and interval backups.
 * Both are supporter features — they sell "my server keeps working while I sleep".
 */
const { createLogger } = require('../core/util');
const instances = require('./instances');
const license = require('../licensing/license');

const log = createLogger('scheduler');

let timer = null;
let managerRef = null;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clockKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function init(manager) {
  managerRef = manager;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((err) => log.warn(`scheduler tick failed: ${err.message}`));
  }, 30000);
  if (timer.unref) timer.unref();
  log.info('scheduler started');
}

async function tick() {
  if (!managerRef) return;
  for (const meta of instances.list()) {
    const rt = managerRef.runtime.get(meta.id);
    const online = !!(rt && rt.supervisor && rt.supervisor.online);

    // ---- scheduled restart ------------------------------------------------
    if (meta.scheduleRestarts && meta.scheduledRestart && online) {
      if (meta.scheduledRestart === clockKey() && meta.lastScheduledRun !== todayKey()) {
        if (!license.hasFeature('scheduledRestarts')) {
          managerRef._emit('error', meta.id, {
            message: 'Scheduled restarts need a supporter licence.',
            where: 'license',
            upsell: 'scheduledRestarts'
          });
        } else {
          instances.update(meta.id, { lastScheduledRun: todayKey() });
          managerRef._emit('log', meta.id, { line: 'Scheduled restart triggered.', level: 'warn', event: null });
          if (meta.backup && meta.backup.enabled) {
            try {
              const backup = require('./backup');
              await backup.createBackup(managerRef, meta.id, { label: 'sched' });
              backup.pruneBackups(meta.id, meta.backup.keep || 7);
            } catch (err) {
              managerRef._emit('log', meta.id, { line: `Pre-restart backup failed: ${err.message}`, level: 'error', event: null });
            }
          }
          managerRef.restartInstance(meta.id).catch((err) => {
            managerRef._emit('error', meta.id, { message: `Scheduled restart failed: ${err.message}`, where: 'scheduler' });
          });
        }
      }
    }

    // ---- interval backups -------------------------------------------------
    if (meta.backup && meta.backup.enabled && online) {
      const every = (meta.backup.intervalHours || 6) * 3600 * 1000;
      const last = meta.backup.lastRunAt ? new Date(meta.backup.lastRunAt).getTime() : 0;
      const due = Date.now() - last > every;
      const alreadyRunning = rt && rt.backupRunning;
      if (due && !alreadyRunning) {
        if (!license.hasFeature('autoBackups')) {
          if (!meta.backupWarnedAt || Date.now() - new Date(meta.backupWarnedAt).getTime() > 86400000) {
            instances.update(meta.id, { backupWarnedAt: new Date().toISOString() });
            managerRef._emit('error', meta.id, {
              message: 'Automatic backups need a supporter licence.',
              where: 'license',
              upsell: 'autoBackups'
            });
          }
        } else {
          if (rt) rt.backupRunning = true;
          try {
            const backup = require('./backup');
            await backup.createBackup(managerRef, meta.id, { label: 'auto' });
            backup.pruneBackups(meta.id, meta.backup.keep || 7);
          } catch (err) {
            log.warn(`auto backup failed for ${meta.id}: ${err.message}`);
          } finally {
            if (rt) rt.backupRunning = false;
          }
        }
      }
    }
  }
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { init, stop, tick };
