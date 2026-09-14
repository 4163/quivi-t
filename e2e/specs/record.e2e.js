import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import menubarPage from '../pageobjects/menubar.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import { fixtures } from '../helpers/fixtures.js';
import { initRecorderShim } from '../helpers/recorder-shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(__dirname, '../scenarios');

function getCliArg(flag, defaultVal = null) {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === `--${flag}` || arg === `-${flag}`) {
      const next = process.argv[i + 1];
      if (next && !next.startsWith('-')) return next;
      return true;
    }
    if (arg.startsWith(`--${flag}=`)) {
      return arg.substring(flag.length + 3);
    }
  }
  return defaultVal;
}

describe('Command Action Recorder', function () {
  this.timeout(1800000); // 30 minutes for user interaction

  it('records user command actions and outputs a scenario trace', async function () {
    this.timeout(1800000);
    await menubarPage.ensureMainWindow();

    const scenarioName = process.env.SCENARIO || getCliArg('scenario') || getCliArg('name') || 'last-recording';
    const rawInitialPath = process.env.INITIAL_PATH || getCliArg('initial-path') || getCliArg('path') || fixtures.testPng;
    let initialPath = rawInitialPath;
    if (!path.isAbsolute(initialPath)) {
      const projectRoot = path.resolve(__dirname, '../..');
      initialPath = path.resolve(projectRoot, initialPath);
    }

    // Load initial file or directory into viewport
    await browser.execute((filePath) => {
      if (window.__TAURI__?.event?.emit) {
        window.__TAURI__.event.emit('single-instance-open', filePath);
      }
    }, initialPath);

    await browser.waitUntil(
      async () => !(await viewerPage.isDropOverlayVisible()),
      { timeout: 10000, timeoutMsg: 'Initial image failed to load into viewport' }
    );

    // Inject detached recorder shim into webview
    await browser.execute(initRecorderShim);

    console.log(`\n======================================================`);
    console.log(`[RECORDING ACTIVE] Scenario: "${scenarioName}"`);
    console.log(`Use the floating badge controls: [Start/Pause], [Reset], [Stop].`);
    console.log(`Press 'Escape' or simply close the window when done to finalize.`);
    console.log(`======================================================\n`);

    // Poll latest trace continuously into Node memory and detect window exit immediately
    let latestTrace = null;
    let windowClosed = false;

    try {
      await browser.waitUntil(
        async () => {
          try {
            const handles = await browser.getWindowHandles().catch(() => []);
            if (!handles || handles.length === 0) {
              windowClosed = true;
              return true;
            }

            const state = await browser.execute(() => {
              if (!window.__QUIVIT_RECORDER__) return null;
              return {
                isDone: !!window.__QUIVIT_RECORDER__.isDone,
                trace: window.__QUIVIT_RECORDER__.getTrace(),
              };
            }).catch((err) => {
              const msg = (err?.message || String(err)).toLowerCase();
              if (
                msg.includes('no such window') ||
                msg.includes('closed') ||
                msg.includes('not reachable') ||
                msg.includes('disconnected') ||
                msg.includes('invalid session') ||
                msg.includes('web view not found') ||
                msg.includes('session deleted') ||
                msg.includes('failed to check if window was closed')
              ) {
                windowClosed = true;
                return { isDone: true, trace: latestTrace };
              }
              return null;
            });

            if (state?.trace) {
              latestTrace = state.trace;
            }

            if (state?.isDone || windowClosed) {
              return true;
            }

            return false;
          } catch {
            windowClosed = true;
            return true;
          }
        },
        {
          timeout: 1800000,
          interval: 200,
          timeoutMsg: 'Recording session timed out after 30 minutes without completion.',
        }
      );
    } catch {
      // Handled by latestTrace fallback below
    }

    if (!latestTrace) {
      try {
        latestTrace = await browser.execute(() => {
          return window.__QUIVIT_RECORDER__ ? window.__QUIVIT_RECORDER__.getTrace() : null;
        });
      } catch {}
    }

    if (latestTrace && latestTrace.actions && latestTrace.actions.length > 0) {
      if (!fs.existsSync(scenariosDir)) {
        fs.mkdirSync(scenariosDir, { recursive: true });
      }

      const scenarioPayload = {
        name: scenarioName,
        recordedAt: new Date().toISOString(),
        initialPath: latestTrace.initialState?.container || initialPath,
        initialState: latestTrace.initialState,
        actions: latestTrace.actions,
      };

      const targetFile = path.join(scenariosDir, `${scenarioName}.json`);
      fs.writeFileSync(targetFile, JSON.stringify(scenarioPayload, null, 2), 'utf-8');

      console.log(`\n======================================================`);
      console.log(`[RECORD COMPLETE] Captured ${latestTrace.actions.length} action(s).`);
      console.log(`Saved scenario to: ${targetFile}`);
      console.log(`======================================================\n`);
    } else {
      console.log(`\n[RECORD FINISHED] Session ended without recorded actions.\n`);
    }
  });
});
