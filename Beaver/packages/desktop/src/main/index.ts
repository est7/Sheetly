import { join } from 'node:path';
import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron';
import { electronApp, is } from '@electron-toolkit/utils';

let mainWindow: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;

/** Load either the Main (`index.html`) or Preferences (`preferences.html`)
 * renderer entry: the dev server serves them by path; the packaged build
 * loads the built HTML files. */
function loadRenderer(window: BrowserWindow, entry: 'index' | 'preferences'): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${entry}.html`);
  } else {
    void window.loadFile(join(__dirname, `../renderer/${entry}.html`));
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  loadRenderer(mainWindow, 'index');
}

/** The dedicated Preferences window (macOS Cmd-,). Config editing lives here,
 * not in the Main workbench, so the workbench stays uncluttered. */
function openPreferencesWindow(): void {
  if (preferencesWindow) {
    preferencesWindow.focus();
    return;
  }
  preferencesWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    show: false,
    resizable: true,
    title: 'Preferences',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });
  preferencesWindow.on('ready-to-show', () => preferencesWindow?.show());
  preferencesWindow.on('closed', () => {
    preferencesWindow = null;
  });
  loadRenderer(preferencesWindow, 'preferences');
}

/** Minimal app menu carrying the Preferences accelerator (Cmd-, / Ctrl-,). */
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: openPreferencesWindow },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: isMac
        ? [{ role: 'close' as const }]
        : [
            { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: openPreferencesWindow },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.beaver.desktop');

  // Placeholder IPC — the real handlers proxy the daemon's config get/set
  // (CLI-first: Preferences is a GUI slot over the same daemon capability).
  ipcMain.handle('preferences:open', () => {
    openPreferencesWindow();
  });

  buildMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
