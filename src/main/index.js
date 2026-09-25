'use strict';
/**
 * Electron main process: window, tray, menu, IPC wiring.
 *
 * All actual work lives in src/main/servers/manager.js so it can be driven
 * headlessly by tools/headless-test.js without Electron.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { ensureDirs, getDirs } = require('./core/paths');
const { createLogger, setLogSink, getLogRing, which } = require('./core/util');
const settings = require('./core/settings');
const { ServerManager } = require('./servers/manager');

const log = createLogger('app');

// portability: --data-dir=<path> or MCSERVERSMITH_DATA env
const dataArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dataArg) process.env.MCSERVERSMITH_DATA = dataArg.split('=')[1];

const isDev = process.argv.includes('--dev');
const isPortable = process.argv.includes('--portable');
const isSmoke = process.env.MCSERVERSMITH_SMOKE === '1';

let mainWindow = null;
let tray = null;
let manager = null;
let quitting = false;

// ---------------------------------------------------------------------------
// single instance
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

// ---------------------------------------------------------------------------
function createWindow() {
  const state = settings.get('windowState', { width: 1240, height: 820 }) || { width: 1240, height: 820 };
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'MCServerSmith',
    show: false,
    autoHideMenuBar: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // surface renderer problems in the app log — without this a broken UI is silent
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log.error(`renderer: ${message} (${sourceId}:${line})`);
    else if (isDev) log.info(`renderer: ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error(`renderer failed to load ${url}: ${desc} (${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer process gone: ${details.reason}`);
  });

  mainWindow.once('ready-to-show', () => { if (!isSmoke) mainWindow.show(); });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  const saveState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    if (!mainWindow.isMaximized()) settings.set({ windowState: bounds });
  };
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);

  // minimise to tray instead of closing (a server should keep running)
  mainWindow.on('close', (e) => {
    if (!quitting && settings.get('closeToTray', true)) {
      e.preventDefault();
      mainWindow.hide();
      notify('MCServerSmith is still running', 'Your servers keep running in the background. Use the tray icon to open the window again.');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    path.join(__dirname, '..', '..', 'resources', 'icon.ico')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined;
}

function notify(title, body) {
  try {
    if (tray) tray.displayBalloon ? tray.displayBalloon({ title, content: body }) : null;
  } catch { /* ignore */ }
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath() || '');
  if (icon.isEmpty()) {
    // 1x1 transparent fallback so the app still starts without bundling art
    tray = new Tray(nativeImage.createEmpty());
  } else {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
  }

  const rebuild = async () => {
    let statuses = [];
    try { statuses = await manager.statuses(); } catch { /* ignore */ }
    const items = statuses.length
      ? statuses.map((s) => ({
        label: `${s.state === 'online' ? '● ' : s.state === 'starting' ? '◐ ' : '○ '}${s.name} (${s.players.online}/${s.players.max})`,
        submenu: [
          { label: 'Start', click: () => manager.startInstance(s.id).catch((e) => log.error(e.message)) },
          { label: 'Stop', click: () => manager.stopInstance(s.id).catch((e) => log.error(e.message)) },
          { label: 'Restart', click: () => manager.restartInstance(s.id).catch((e) => log.error(e.message)) },
          { type: 'separator' },
          { label: 'Open folder', click: () => shell.openPath(require('./servers/instances').instancePaths(s.id).dir) }
        ]
      }))
      : [{ label: 'No servers yet', enabled: false }];

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'MCServerSmith', enabled: false },
      { type: 'separator' },
      ...items,
      { type: 'separator' },
      { label: 'Open window', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
      ...(statuses.some((s) => s.state === 'online') ? [{ label: 'Stop all servers', click: () => stopAll() }] : []),
      { type: 'separator' },
      { label: 'Quit', click: () => quitApp() }
    ]));
  };

  tray.setToolTip('MCServerSmith');
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
  rebuild();
  setInterval(rebuild, 5000).unref?.();
}

async function stopAll() {
  for (const meta of require('./servers/instances').list()) {
    try { await manager.stopInstance(meta.id); } catch { /* ignore */ }
  }
}

async function quitApp() {
  const statuses = await manager.statuses().catch(() => []);
  const running = statuses.filter((s) => s.state !== 'offline');
  if (running.length) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Stop servers and quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Servers are still running',
      message: `${running.length} server(s) are still running.`,
      detail: 'They will be stopped (with a save) before MCServerSmith exits.'
    });
    if (response !== 0) return;
  }
  quitting = true;
  await stopAll();
  manager.stopPolling();
  app.quit();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New server…', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('menu', { action: 'new-server' }) },
        { type: 'separator' },
        { label: 'Open data folder', click: () => shell.openPath(getDirs().root) },
        { label: 'Open app log', click: () => shell.openPath(getDirs().appLog) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com/lelewithheart/mcserversmith#readme')
        },
        {
          label: `Version ${require('../../package.json').version}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'Show diagnostics',
          click: async () => {
            const info = await manager.appInfo();
            const caps = Object.entries(info.capabilities).map(([k, v]) => `${k}: ${v ? 'yes' : 'NO'}`).join('\n');
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Diagnostics',
              message: `MCServerSmith ${info.version}`,
              detail: [
                `Electron ${info.electron} · Node ${info.node}`,
                `Platform ${info.platform}/${info.arch}`,
                `Data folder ${info.dataRoot}`,
                `Licence: ${info.license.tier}`,
                '',
                'System tools:',
                caps
              ].join('\n')
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  if (isPortable) {
    process.env.MCSERVERSMITH_DATA = path.join(path.dirname(app.getPath('exe')), 'MCServerSmithData');
  }
  ensureDirs();
  settings.load();

  setLogSink((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-log', entry);
    }
    try {
      fs.appendFileSync(getDirs().appLog, `${entry.t} [${entry.level}] [${entry.scope}] ${entry.message}\n`);
    } catch { /* ignore */ }
  });

  manager = new ServerManager();
  manager.init();
  manager.on('event', (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-event', ev);
  });

  require('./ipc').register({ ipcMain, manager, shell, dialog, app, getWindow: () => mainWindow });

  createWindow();
  createTray();
  buildMenu();

  if (isSmoke) {
    // automated UI check — drives the renderer, prints a report, exits
    log.info('smoke mode: driving the UI…');
    const { run: runSmoke } = require('./smoke');
    runSmoke({ window: mainWindow })
      .then((code) => {
        log.info(`smoke mode: finished with code ${code}`);
        manager.stopPolling();
        quitting = true;
        app.exit(code);
      })
      .catch((err) => {
        log.error(`smoke test crashed: ${err.stack || err.message}`);
        app.exit(3);
      });
  }

  log.info(`MCServerSmith ${require('../../package.json').version} started (${process.platform}/${process.arch})`);
  log.info(`git: ${which('git') || 'not found'} | tar: ${which('tar') || 'not found'} | unzip: ${which('unzip') || 'not found'}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });

  app.on('before-quit', () => { quitting = true; });
});

// keep running in the tray when all windows are closed
app.on('window-all-closed', () => {
  if (!settings.get('closeToTray', true)) {
    quitting = true;
    app.quit();
  }
});

process.on('uncaughtException', (err) => {
  log.error(`uncaught: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  log.error(`unhandled rejection: ${err && err.message ? err.message : err}`);
});
