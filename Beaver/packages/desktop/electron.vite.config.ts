import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// electron-vite v5's renderer `build` type narrows to IsolatedEntriesMixin and
// drops Vite's `rollupOptions` (our multi-window entries); the config is valid
// at runtime, so cast at the boundary rather than distort it.
const config = {
  main: {
    // Bundle the workspace TS packages into the main process (Node can't
    // require raw .ts); everything else stays external.
    plugins: [externalizeDepsPlugin({ exclude: ['@beaver/core', '@beaver/client'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // Two windows = two HTML entries: the Main workbench and the
        // dedicated Preferences window.
        input: {
          index: resolve('src/renderer/index.html'),
          preferences: resolve('src/renderer/preferences.html')
        }
      }
    }
  }
};

export default defineConfig(config as UserConfig);
