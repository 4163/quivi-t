import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

process.env.QUIVIT_E2E_SUITE = '1';

let devStateRestored = false;
const originalLocalAppData = process.env.LOCALAPPDATA;
const e2eLocalAppData = path.resolve(__dirname, 'src-tauri/target/debug/.e2e-localappdata');

function resetE2eLocalAppData() {
  const targetDir = path.resolve(__dirname, 'src-tauri/target/debug');
  if (!e2eLocalAppData.startsWith(`${targetDir}${path.sep}`)) {
    throw new Error('Refusing to clear an E2E library outside the debug target directory');
  }
  try { fs.rmSync(e2eLocalAppData, { recursive: true, force: true }); } catch {}
}

function restoreAndCleanDevState(targetDir, backupDir, isolatedFiles) {
  if (devStateRestored) return;
  devStateRestored = true;
  for (const file of isolatedFiles) {
    const p = path.join(targetDir, file);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
  if (fs.existsSync(backupDir)) {
    for (const file of isolatedFiles) {
      const src = path.join(backupDir, file);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(targetDir, file)); } catch {}
      }
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  }
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
    // Persistent profile shared by record/replay/diagnose runs so setup done
    // before recording stays in effect at replay. The main suite keeps
    // factory-fresh isolation. Kept outside targetDir so dev rebuilds and the
    // dev-state backup never touch it.
    const profileDir = path.resolve(__dirname, 'e2e/.profile');
    const profileFiles = [
      '.portable',
      'quivit_config.json',
      'quivit_state.json',
      'quivit_directory_sort.json',
      'quivit_favorites.json',
      'custom_css.css',
    ];
    const cliArgs = process.argv;
    const wantsProfile = cliArgs.some((a) => a.includes('record.e2e.js') || a.includes('replay.e2e.js'));
    const wantsFresh = !!process.env.E2E_FRESH || cliArgs.includes('--fresh') || cliArgs.includes('--e2e-fresh');
    const hasProfile = fs.existsSync(path.join(profileDir, 'quivit_config.json'));
    const backupDir = path.join(targetDir, '.e2e-config-backup');
    const isolatedFiles = [
      '.portable',
      'quivit_config.json',
      'quivit_state.json',
      'quivit_directory_sort.json',
      'quivit_favorites.json',
      'custom_css.css',
    ];

    process.env.LOCALAPPDATA = e2eLocalAppData;
    resetE2eLocalAppData();

    // Back up real dev exe-dir state before isolation wipes it. Record and
    // diagnose share the debug exe dir with `tauri dev`, so wiping without
    // backup destroys a portable dev config. A leftover backup means the
    // previous run never restored; keep it so the original state survives.
    if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
      console.warn('[E2E] Leftover backup found, keeping it (previous run may not have restored).');
    } else {
      fs.mkdirSync(backupDir, { recursive: true });
      let isLeftoverIsolation = false;
      try {
        const targetCfg = JSON.parse(fs.readFileSync(path.join(targetDir, 'quivit_config.json'), 'utf8'));
        if (targetCfg?.frontend_data?.e2e_suite === true) {
          isLeftoverIsolation = true;
        }
      } catch {}
      if (!isLeftoverIsolation) {
        for (const file of isolatedFiles) {
          const src = path.join(targetDir, file);
          if (fs.existsSync(src)) {
            try { fs.copyFileSync(src, path.join(backupDir, file)); } catch {}
          }
        }
      }
    }

    // Register process exit listeners so interrupted runs clean up isolation and restore dev state
    process.once('SIGINT', () => {
      restoreAndCleanDevState(targetDir, backupDir, isolatedFiles);
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      restoreAndCleanDevState(targetDir, backupDir, isolatedFiles);
      process.exit(143);
    });
    process.once('exit', () => {
      restoreAndCleanDevState(targetDir, backupDir, isolatedFiles);
    });

    // Terminate leftover processes so the executable is not locked during test run or build
    if (process.platform === 'win32') {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Stop-Process -Name tauri-app, tauri-driver, msedgedriver -Force -ErrorAction SilentlyContinue'],
        { stdio: 'ignore' }
      );
    }

    // Isolate E2E tests in portable mode so they start clean and do not touch user AppData.
    // Record/replay runs reuse the persistent profile so diagnose replays the
    // same prefs that were active at record time.
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    if (wantsProfile && hasProfile && !wantsFresh) {
      console.log('[E2E] Restoring persistent profile into exe dir...');
      // Wipe first (dev state is already backed up above) so files the
      // profile does not have cannot leak into the run.
      for (const file of profileFiles) {
        const p = path.join(targetDir, file);
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
      for (const file of profileFiles) {
        const src = path.join(profileDir, file);
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, path.join(targetDir, file)); } catch {}
        }
      }
      // Never start an E2E run without the marker; without it the app would
      // read roaming user data.
      if (!fs.existsSync(path.join(targetDir, '.portable'))) {
        fs.writeFileSync(path.join(targetDir, '.portable'), '');
      }
      // Same for the flag itself: a hand-edited profile must not flip the
      // suite back to roaming.
      try {
        const runCfgPath = path.join(targetDir, 'quivit_config.json');
        const runCfg = JSON.parse(fs.readFileSync(runCfgPath, 'utf8'));
        if (!runCfg.portable_mode) {
          runCfg.portable_mode = true;
          fs.writeFileSync(runCfgPath, JSON.stringify(runCfg, null, 2));
        }
      } catch {}
    } else {
      if (wantsProfile && wantsFresh) {
        console.log('[E2E] Fresh reset requested; clearing persistent profile...');
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
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
    const targetDir = path.resolve(__dirname, 'src-tauri/target/debug');
    const backupDir = path.join(targetDir, '.e2e-config-backup');
    const profileDir = path.resolve(__dirname, 'e2e/.profile');
    const isolatedFiles = [
      '.portable',
      'quivit_config.json',
      'quivit_state.json',
      'quivit_directory_sort.json',
      'quivit_favorites.json',
      'custom_css.css',
    ];
    // Record/replay runs save the mutated isolation files back to the
    // persistent profile first, so the next diagnose run starts from the
    // same prefs. last_opened_path is kept so "continue from last opened"
    // works; last-session image state is dropped and remember_last_image is
    // forced off so replay starts at the recorded index. portable_mode is
    // forced on so the suite can never fall back to roaming user data.
    const cliArgs = process.argv;
    const wantsProfile = cliArgs.some((a) => a.includes('record.e2e.js') || a.includes('replay.e2e.js'));
    if (wantsProfile) {
      fs.mkdirSync(profileDir, { recursive: true });
      for (const file of isolatedFiles) {
        const src = path.join(targetDir, file);
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, path.join(profileDir, file)); } catch {}
        }
      }
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
    // Remove isolation files, then restore the dev exe-dir state that
    // onPrepare backed up. Without restore, a portable dev config stays
    // wiped and the next `tauri dev` starts from factory defaults.
    restoreAndCleanDevState(targetDir, backupDir, isolatedFiles);
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
