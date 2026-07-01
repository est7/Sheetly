import type { ElectronAPI } from '@electron-toolkit/preload';
import type { BeaverApi } from './index';

declare global {
  interface Window {
    electron: ElectronAPI;
    beaver: BeaverApi;
  }
}
