import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import menubarPage from '../pageobjects/menubar.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import { fixtures } from '../helpers/fixtures.js';
import { initRecorderShim } from '../helpers/recorder-shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(__dirname, '../scenarios');

describe('Command Action Recorder', function () {
  this.timeout(1800000); // 30 minutes for user interaction

  it('records user command actions and outputs a scenario trace', async function () {
    this.timeout(1800000);
    await menubarPage.ensureMainWindow();

    const scenarioName = process.env.SCENARIO || 'last-recording';
    const initialPath = process.env.INITIAL_PATH || fixtures.testPng;

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
    console.log(`Interact with the QuiviT window to reproduce issues.`);
    console.log(`Press 'Escape' in the app or click 'Finish Recording' when done.`);
    console.log(`======================================================\n`);

    // Wait until user finishes recording
    let windowClosedEarly = false;
    try {
      await browser.waitUntil(
        async () => {
          try {
            return await browser.execute(() => !!(window.__QUIVIT_RECORDER__ && window.__QUIVIT_RECORDER__.isDone));
          } catch (err) {
            const msg = err?.message || String(err);
            if (msg.includes('no such window') || msg.includes('web view not found') || msg.includes('target window already closed')) {
              windowClosedEarly = true;
              return true;
            }
            throw err;
          }
        },
        {
          timeout: 1800000,
          interval: 250,
          timeoutMsg: 'Recording session timed out after 30 minutes without completion.',
        }
      );
    } catch (err) {
      if (!windowClosedEarly) throw err;
    }

    if (windowClosedEarly) {
      console.warn('\n[RECORD NOTICE] Window was closed before clicking "Finish Recording".');
      console.warn('To save your scenario, click "Finish Recording" on the badge or press "Escape".\n');
      return;
    }

    const trace = await browser.execute(() => {
      return window.__QUIVIT_RECORDER__ ? window.__QUIVIT_RECORDER__.getTrace() : null;
    });

    if (!trace) {
      throw new Error('Failed to retrieve recording trace from webview');
    }

    if (!fs.existsSync(scenariosDir)) {
      fs.mkdirSync(scenariosDir, { recursive: true });
    }

    const scenarioPayload = {
      name: scenarioName,
      recordedAt: new Date().toISOString(),
      initialPath: trace.initialState?.container || initialPath,
      initialState: trace.initialState,
      actions: trace.actions,
    };

    const targetFile = path.join(scenariosDir, `${scenarioName}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(scenarioPayload, null, 2), 'utf-8');

    console.log(`\n[RECORD COMPLETE] Saved ${trace.actions.length} action(s) to ${targetFile}\n`);
  });
});
