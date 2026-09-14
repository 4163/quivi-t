import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const config = {
  runner: 'local',
  specs: ['./e2e/specs/0*.e2e.js'],
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
    const targetDir = path.resolve(__dirname, 'src-tauri/target/debug');
    const binaryPath = path.join(targetDir, 'tauri-app.exe');

    // Terminate leftover processes so the executable is not locked during test run or build
    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name tauri-app, tauri-driver, msedgedriver -Force -ErrorAction SilentlyContinue'],
        { stdio: 'ignore' }
      );
    }

    // Isolate E2E tests in portable mode so they start clean and do not touch user AppData
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(path.join(targetDir, '.portable'), '');
    const cleanFiles = [
      'quivit_config.json',
      'quivit_state.json',
      'quivit_directory_sort.json',
      'quivit_favorites.json',
      'custom_css.css',
    ];
    for (const file of cleanFiles) {
      const p = path.join(targetDir, file);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
    // Write factory-default portable config so saves stay in targetDir
    fs.writeFileSync(
      path.join(targetDir, 'quivit_config.json'),
      JSON.stringify({ portable_mode: true, frontend_data: {} }, null, 2)
    );

    console.log('Building Tauri debug binary for E2E testing...');
    const res = spawnSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true,
    });
    if (res.status !== 0) {
      if (!fs.existsSync(binaryPath)) {
        throw new Error(`Failed to build Tauri app (exit code ${res.status})`);
      }
      console.warn(`cargo build exited with code ${res.status}; falling back to existing binary.`);
    }
  },
  onComplete: () => {
    const targetDir = path.resolve(__dirname, 'src-tauri/target/debug');
    const portablePath = path.join(targetDir, '.portable');
    if (fs.existsSync(portablePath)) {
      try { fs.unlinkSync(portablePath); } catch {}
    }
    const cleanFiles = [
      'quivit_config.json',
      'quivit_state.json',
      'quivit_directory_sort.json',
      'quivit_favorites.json',
      'custom_css.css',
    ];
    for (const file of cleanFiles) {
      const p = path.join(targetDir, file);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name tauri-driver, msedgedriver -Force -ErrorAction SilentlyContinue'],
        { stdio: 'ignore' }
      );
    }
  },
};
