import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

/**
 * Renderer-facing bridge. Kept intentionally thin: the daemon is the SSOT, so
 * these calls will proxy the daemon's CLI-reachable capabilities (config
 * get/set, runs, event stream). Only `preferences.open` is wired today.
 */
const beaver = {
  preferences: {
    open: (): Promise<void> => ipcRenderer.invoke('preferences:open')
  }
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('beaver', beaver);
  } catch (error) {
    console.error(error);
  }
} else {
  // No contextIsolation: attach directly. Object.assign avoids depending on the
  // Window augmentation (declared in index.d.ts, which the renderer project owns).
  Object.assign(window, { electron: electronAPI, beaver });
}

export type BeaverApi = typeof beaver;
