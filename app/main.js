// Super Photo Kassa - hoofdproces (venster, printen, lokale opslag, updates)
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
if (process.env.SP_USERDATA) app.setPath('userData', process.env.SP_USERDATA);   // alleen voor testen
const dataDir = () => app.getPath('userData');

// ---------- lokale opslag (JSON-bestanden, veilig weggeschreven) ----------
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); }
  catch { return fallback; }
}
function writeJson(name, value) {
  const file = path.join(dataDir(), name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);           // atomisch: nooit een half bestand
  return true;
}
const SAFE_NAME = /^[A-Za-z0-9_-]{1,40}$/;

ipcMain.handle('store:get', (_e, name, fallback) => {
  if (!SAFE_NAME.test(name)) throw new Error('bad name');
  return readJson(name + '.json', fallback);
});
ipcMain.handle('store:set', (_e, name, value) => {
  if (!SAFE_NAME.test(name)) throw new Error('bad name');
  return writeJson(name + '.json', value);
});

// ---------- printen ----------
ipcMain.handle('print:list', async () => {
  const list = await win.webContents.getPrintersAsync();
  return list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
});

ipcMain.handle('print:receipt', async (_e, { html, widthMm, printer }) => {
  const pxPerMm = 96 / 25.4;
  const pw = new BrowserWindow({
    show: false, width: Math.ceil(widthMm * pxPerMm), height: 600,
    webPreferences: { sandbox: true }
  });
  try {
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // hoogte van de bon meten zodat de printer niet meters leeg papier uitspuugt
    const heightPx = await pw.webContents
      .executeJavaScript('document.documentElement.scrollHeight', true)
      .catch(() => 1200);
    const heightMicrons = Math.max(Math.ceil((heightPx / pxPerMm + 8) * 1000), 60000);
    const opts = {
      silent: !!printer,
      deviceName: printer || undefined,
      printBackground: false,
      margins: { marginType: 'none' },
      pageSize: { width: widthMm * 1000, height: heightMicrons }
    };
    return await new Promise(resolve => {
      pw.webContents.print(opts, (ok, reason) => resolve({ ok, reason: ok ? null : reason }));
    });
  } finally {
    setTimeout(() => { if (!pw.isDestroyed()) pw.destroy(); }, 1500);
  }
});

// ---------- updates ----------
let updater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', i => send('update', { state: 'downloading', version: i.version }));
    updater.on('update-downloaded', i => send('update', { state: 'ready', version: i.version }));
    updater.on('error', err => send('update', { state: 'error', message: String(err && err.message || err) }));
  } catch (e) { updater = null; /* updates zijn optioneel */ }
}
// De update-bron (GitHub 'eigenaar/repository') staat in de database en wordt na het starten doorgegeven.
let feedSet = false;
ipcMain.handle('update:source', (_e, repo) => {
  if (!updater || feedSet || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) return false;
  const [owner, name] = repo.split('/');
  updater.setFeedURL({ provider: 'github', owner, repo: name, releaseType: 'release' });
  feedSet = true;
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
  return true;
});
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
ipcMain.handle('update:install', () => { if (updater) updater.quitAndInstall(false, true); });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: dataDir() }));

// ---------- venster ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 800, minWidth: 1100, minHeight: 650,
    backgroundColor: '#f4f1ec', title: 'Super Photo Kassa',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  });
  win.maximize();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // links nooit binnen de kassa openen
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // per ongeluk sluiten met lopende bon voorkomen
  let lastAsk = 0;
  win.on('close', e => {
    if (win.__allowClose) return;
    // tweede keer sluiten binnen 8 seconden = altijd sluiten (ook als het scherm vastzit)
    if (Date.now() - lastAsk < 8000) return;
    lastAsk = Date.now();
    e.preventDefault();
    win.webContents.send('app:close-request');
  });
}
ipcMain.handle('app:close', () => { win.__allowClose = true; win.close(); });

app.commandLine.appendSwitch('lang', 'nl-NL');   // datums als dd-mm-jjjj
const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Programma', submenu: [
        { role: 'reload', label: 'Opnieuw laden' },
        { role: 'togglefullscreen', label: 'Volledig scherm' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'Groter' }, { role: 'zoomOut', label: 'Kleiner' }, { role: 'resetZoom', label: 'Normale grootte' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Ontwikkelaarshulpmiddelen' },
        { label: 'Afsluiten', click: () => win && win.close() }
      ]}
    ]));
    createWindow();
    setupUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
