import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const config = {
  runner: 'local',
  specs: ['./e2e/specs/**/*.e2e.js'],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      browserName: 'tauri',
      'tauri:options': {
        application: './src-tauri/target/debug/tauri-app.exe',
      },
    },
  ],
  logLevel: 'info',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [
    [
      'tauri',
      {
        application: './src-tauri/target/debug/tauri-app.exe',
        driverProvider: 'external',
        autoInstallTauriDriver: true,
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  onPrepare: () => {
    const binaryPath = path.resolve(__dirname, 'src-tauri/target/debug/tauri-app.exe');
    if (!fs.existsSync(binaryPath) || process.env.TAURI_BUILD) {
      console.log('Building Tauri debug binary for E2E testing...');
      const res = spawnSync('npm', ['run', 'tauri', 'build', '--', '--debug', '--no-bundle'], {
        cwd: __dirname,
        stdio: 'inherit',
        shell: true,
      });
      if (res.status !== 0) {
        throw new Error(`Failed to build Tauri app (exit code ${res.status})`);
      }
    }
  },
  onComplete: () => {
    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name tauri-driver, msedgedriver -Force -ErrorAction SilentlyContinue'],
        { stdio: 'ignore' }
      );
    }
  },
};
