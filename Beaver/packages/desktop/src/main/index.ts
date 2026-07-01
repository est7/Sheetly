import { join } from 'node:path';
import http from 'node:http';
import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron';
import { electronApp, is } from '@electron-toolkit/utils';
import { BeaverClient } from '@beaver/client';
import { beaverPaths, type BeaverConfig, type RunEvent } from '@beaver/core';

let mainWindow: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;

const socketPath = beaverPaths().socketPath;
const client = new BeaverClient(socketPath);

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

/**
 * Live event stream: subscribe to the daemon's SSE `/events`, forward each run
 * event to the Main window, and reconnect from the last seq (D19 resumable
 * cursor) if the daemon restarts or the socket drops. One shared stream for all
 * runs; the renderer filters by the selected run.
 */
function startEventStream(): void {
  let lastSeq = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) {
      return;
    }
    const request = http.request(
      { socketPath, path: `/events?since=${lastSeq}`, method: 'GET' },
      (response) => {
        emitStreamStatus(true);
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            handleFrame(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
          }
        });
        response.on('end', () => scheduleReconnect());
        response.on('error', () => scheduleReconnect());
      }
    );
    request.on('error', () => {
      emitStreamStatus(false);
      scheduleReconnect();
    });
    request.end();
  };

  const handleFrame = (frame: string): void => {
    let event: string | undefined;
    let data: string | undefined;
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }
    if (event !== 'run' || !data) {
      return;
    }
    try {
      const runEvent = JSON.parse(data) as RunEvent;
      if (typeof runEvent.seq === 'number') {
        lastSeq = runEvent.seq;
      }
      mainWindow?.webContents.send('beaver:event', runEvent);
    } catch {
      // malformed frame — skip, the cursor stays put so nothing is lost
    }
  };

  let reconnectTimer: NodeJS.Timeout | undefined;
  const scheduleReconnect = (): void => {
    emitStreamStatus(false);
    if (closed || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 1500);
  };

  app.on('before-quit', () => {
    closed = true;
  });
  connect();
}

function emitStreamStatus(connected: boolean): void {
  mainWindow?.webContents.send('beaver:stream-status', connected);
}

/** Wrap a daemon call so a thrown BeaverError crosses IPC as a plain object the
 * renderer can render, instead of a raw rejection. */
async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.beaver.desktop');

  ipcMain.handle('preferences:open', () => openPreferencesWindow());
  ipcMain.handle('config:get', () => guard(() => client.getConfig()));
  ipcMain.handle('config:set', (_event, config: BeaverConfig) => guard(() => client.setConfig(config)));
  ipcMain.handle('runs:list', () => guard(() => client.listRuns()));
  ipcMain.handle('runs:get', (_event, runId: string) => guard(() => client.getRun(runId)));
  ipcMain.handle('runs:events', (_event, runId: string) => guard(() => client.runEvents(runId)));

  buildMenu();
  createMainWindow();
  startEventStream();

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
