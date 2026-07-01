import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import type { BeaverConfig, Run, RunEvent } from '@beaver/core';

/** Result envelope: daemon calls never reject across IPC — they resolve to a
 * discriminated ok/error object the renderer renders directly. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Renderer-facing bridge over the daemon (the SSOT). Every capability here maps
 * to a CLI-reachable daemon endpoint via the main process's BeaverClient.
 */
const beaver = {
  preferences: {
    open: (): Promise<void> => ipcRenderer.invoke('preferences:open')
  },
  config: {
    get: (): Promise<IpcResult<BeaverConfig>> => ipcRenderer.invoke('config:get'),
    set: (config: BeaverConfig): Promise<IpcResult<BeaverConfig>> => ipcRenderer.invoke('config:set', config)
  },
  runs: {
    list: (): Promise<IpcResult<Run[]>> => ipcRenderer.invoke('runs:list'),
    get: (runId: string): Promise<IpcResult<Run>> => ipcRenderer.invoke('runs:get', runId),
    events: (runId: string): Promise<IpcResult<RunEvent[]>> => ipcRenderer.invoke('runs:events', runId)
  },
  stream: {
    /** Live run events (all runs); returns an unsubscribe function. */
    onEvent: (callback: (event: RunEvent) => void): (() => void) => {
      const listener = (_event: unknown, runEvent: RunEvent): void => callback(runEvent);
      ipcRenderer.on('beaver:event', listener);
      return () => ipcRenderer.off('beaver:event', listener);
    },
    /** Daemon connection status changes (true = connected). */
    onStatus: (callback: (connected: boolean) => void): (() => void) => {
      const listener = (_event: unknown, connected: boolean): void => callback(connected);
      ipcRenderer.on('beaver:stream-status', listener);
      return () => ipcRenderer.off('beaver:stream-status', listener);
    }
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
