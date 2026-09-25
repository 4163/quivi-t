import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

process.env.QUIVIT_E2E_SUITE = '1';

const originalLocalAppData = process.env.LOCALAPPDATA;
const e2eLocalAppData = path.resolve(__dirname, 'src-tauri/target/debug/.e2e-localappdata');

function resetE2eLocalAppData() {
  const targetDir = path.resolve(__dirname, 'src-tauri/target/debug');
  if (!e2eLocalAppData.startsWith(`${targetDir}${path.sep}`)) {
    throw new Error('Refusing to clear an E2E library outside the debug target directory');
  }
  try { fs.rmSync(e2eLocalAppData, { recursive: true, force: true }); } catch {}
}

// Config isolation runs on env dirs, not copied markers. The app backend
// reads QUIVIT_CONFIG_DIR directly, so each runner owns its folder and
// target/debug never holds settings files again.
const e2eRunDir = path.resolve(__dirname, '.e2e-config');
const e2eProfileDir = path.resolve(__dirname, 'e2e/.profile');

function resetRunDir(dir) {
  // __dirname carries a trailing separator, so resolve it off first.
  // Otherwise the prefix below doubles the separator and rejects everything.
  const repoRoot = path.resolve(__dirname);
  if (!dir.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error('Refusing to clear an E2E config dir outside the repo');
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

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
        args: ['--e2e-suite'],
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
    // Record/replay runs reuse the persistent profile so diagnose replays the
    // same prefs that were active at record time. The main suite rebuilds a
    // factory-fresh folder every run. Both are repo folders addressed by env,
    // so nothing is copied into targetDir and no marker is ever written.
    const cliArgs = process.argv;
    const wantsProfile = cliArgs.some((a) => a.includes('record.e2e.js') || a.includes('replay.e2e.js'));
    const wantsFresh = !!process.env.E2E_FRESH || cliArgs.includes('--fresh') || cliArgs.includes('--e2e-fresh');

    process.env.LOCALAPPDATA = e2eLocalAppData;
    resetE2eLocalAppData();

    if (wantsProfile) {
      if (wantsFresh) {
        console.log('[E2E] Fresh reset requested; clearing persistent profile...');
        resetRunDir(e2eProfileDir);
      } else {
        fs.mkdirSync(e2eProfileDir, { recursive: true });
      }
      process.env.QUIVIT_CONFIG_DIR = e2eProfileDir;
      // Record and diagnose stay comparable run to run: one-file layout.
      process.env.QUIVIT_PORTABLE = '1';
    } else {
      resetRunDir(e2eRunDir);
      process.env.QUIVIT_CONFIG_DIR = e2eRunDir;
      // Suite default is the one-file layout; slice 3 adds a split run.
      // First load returns factory defaults, so no seed file is written.
      process.env.QUIVIT_PORTABLE = '1';
    }

    // Terminate leftover processes so the executable is not locked during test run or build
    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name tauri-app, tauri-driver, msedgedriver -Force -ErrorAction SilentlyContinue'],
        { stdio: 'ignore' }
      );
    }

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
    } else {
      console.log('[E2E] Debug binary ready; launching app...');
    }
  },
  onComplete: () => {
    const profileDir = path.resolve(__dirname, 'e2e/.profile');
    // Record/replay runs wrote straight into the profile folder, so only the
    // scrub runs here: last_opened_path is kept so "continue from last opened"
    // works; last-session image state is dropped and remember_last_image is
    // forced off so replay starts at the recorded index. portable_mode is
    // forced on so the profile can never fall back to roaming user data.
    const cliArgs = process.argv;
    const wantsProfile = cliArgs.some((a) => a.includes('record.e2e.js') || a.includes('replay.e2e.js'));
    if (wantsProfile) {
      try {
        const cfgPath = path.join(profileDir, 'quivit_config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        cfg.portable_mode = true;
        if (cfg.frontend_data) {
          delete cfg.frontend_data.last_active_image;
          delete cfg.frontend_data.scroll_zoom_latched;
          delete cfg.frontend_data.e2e_suite;
          cfg.frontend_data.remember_last_image = false;
        }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      } catch {}
    }
    resetE2eLocalAppData();
    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
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
