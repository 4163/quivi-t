import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import { fixtures } from '../helpers/fixtures.js';
import { initReplayDiagnostics } from '../helpers/replay-diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(__dirname, '../scenarios');

describe('Command Action Replay & Diagnostics', function () {
  this.timeout(1800000); // 30 minutes

  it('replays recorded command actions and checks for rendering race conditions', async function () {
    this.timeout(1800000);
    await menubarPage.ensureMainWindow();

    const scenarioName = process.env.SCENARIO || 'last-recording';
    let targetFile = path.join(scenariosDir, `${scenarioName}.json`);

    if (!fs.existsSync(targetFile)) {
      if (fs.existsSync(scenariosDir)) {
        const available = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
        if (available.length > 0) {
          targetFile = path.join(scenariosDir, available[0]);
          console.warn(`Scenario "${scenarioName}" not found. Falling back to "${available[0]}".`);
        }
      }
    }

    if (!fs.existsSync(targetFile)) {
      throw new Error(`No scenario file found to replay. Expected: ${targetFile}. Record one first using 'npm run test:record'.`);
    }

    const scenario = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    console.log(`\n======================================================`);
    console.log(`[REPLAY START] Scenario: "${scenario.name || scenarioName}"`);
    console.log(`Actions to execute: ${scenario.actions.length}`);
    console.log(`Initial path: ${scenario.initialPath}`);
    if (scenario.initialState) {
      console.log(`Initial container: ${scenario.initialState.container || 'N/A'}`);
      console.log(`Initial file: ${scenario.initialState.filename || 'N/A'} (${scenario.initialState.format || 'unknown'})`);
      if (scenario.initialState.pipeline) {
        console.log(`Initial pipeline: ${JSON.stringify(scenario.initialState.pipeline)}`);
      }
    }
    console.log(`======================================================\n`);

    const initialPath = scenario.initialPath || scenario.initialState?.container || fixtures.testPng;

    // Load initial file into viewport
    await browser.execute((filePath) => {
      if (window.__TAURI__?.event?.emit) {
        window.__TAURI__.event.emit('single-instance-open', filePath);
      }
    }, initialPath);

    await browser.waitUntil(
      async () => !(await viewerPage.isDropOverlayVisible()),
      { timeout: 10000, timeoutMsg: 'Initial image failed to load into viewport' }
    );

    // Ensure initial index matches the recorded state
    if (scenario.initialState?.index !== undefined) {
      await browser.execute(async (targetIdx) => {
        const { Core } = await import('/js/core.js');
        if (Core.getState().index !== targetIdx) {
          await Core.selectIndex(targetIdx);
        }
      }, scenario.initialState.index);
    }

    // Restore initial pipeline settings if recorded
    if (scenario.initialState?.pipeline) {
      await browser.execute((p) => {
        if (p.filter) {
          document.getElementById(`cmd-filter-${p.filter}`)?.click();
        }
        if (p.fitMode) {
          document.getElementById(`cmd-fit-${p.fitMode}`)?.click();
        }
      }, scenario.initialState.pipeline);
    }

    // Inject diagnostic frame observer
    await browser.execute(initReplayDiagnostics);

    const reports = [];
    let totalBlackoutFrames = 0;

    for (let i = 0; i < scenario.actions.length; i++) {
      const stepItem = scenario.actions[i];
      const stepIndex = i + 1;
      const actionId = typeof stepItem === 'string' ? stepItem : stepItem.action;
      const actionContext = typeof stepItem === 'object' ? stepItem.context : null;

      // Start step frame monitor
      await browser.execute((idx, id) => {
        window.__QUIVIT_DIAGNOSTICS__.startStep(idx, id);
      }, stepIndex, actionId);

      // Dispatch action based on action type
      if (actionId === 'select-index' && typeof stepItem === 'object' && stepItem.index !== undefined) {
        await browser.execute(async (idx) => {
          const { Core } = await import('/js/core.js');
          Core.selectIndex(idx);
        }, stepItem.index);
      } else if (actionId === 'jump-to-index' && typeof stepItem === 'object' && stepItem.index !== undefined) {
        await browser.execute(async (idx) => {
          const { Core } = await import('/js/core.js');
          Core.jumpToIndex(idx);
        }, stepItem.index);
      } else if (actionId === 'cmd-toggle-filelist-view-mode') {
        await browser.execute(() => {
          document.getElementById('btn-toggle-view-mode')?.click();
        });
      } else if (actionId === 'open-favorite' && typeof stepItem === 'object' && stepItem.path) {
        await browser.execute((favPath) => {
          if (window.__TAURI__?.event?.emit) {
            window.__TAURI__.event.emit('single-instance-open', favPath);
          }
        }, stepItem.path);
      } else {
        await browser.execute((id) => {
          const el = document.getElementById(id);
          if (el) {
            el.click();
          }
        }, actionId);
      }

      // Wait for image decode, scaling resampler, and paint transition
      await browser.pause(250);

      // Collect diagnostic report for this step
      const stepReport = await browser.execute(() => {
        return window.__QUIVIT_DIAGNOSTICS__.stopStep();
      });

      reports.push(stepReport);
      totalBlackoutFrames += stepReport.blackoutFrameCount;

      const flag = stepReport.blackoutFrameCount > 0 ? ' [FLICKER DETECTED]' : ' [OK]';
      const filename = stepReport.filename || actionContext?.filename || 'N/A';
      const format = actionContext?.format ? ` [${actionContext.format.toUpperCase()}]` : '';
      const pipelineInfo = actionContext?.pipeline
        ? ` (scaling: ${actionContext.pipeline.scaling}, filter: ${actionContext.pipeline.filter})`
        : '';

      console.log(
        `Step ${stepIndex}/${scenario.actions.length} [${actionId}]: ${filename}${format}${pipelineInfo} ` +
        `-> ${stepReport.durationMs}ms, ${stepReport.blackoutFrameCount} blackout frames${flag}`
      );

      if (stepReport.blackoutFrameCount > 0) {
        console.warn(`  Anomaly timeline (${stepReport.blackoutFrameCount} blackout frames detected):`);
        if (stepReport.events && stepReport.events.length > 0) {
          for (const ev of stepReport.events) {
            const dataStr = ev.data ? ` ${JSON.stringify(ev.data)}` : '';
            console.warn(`    [+${ev.t}ms] [${ev.source}] ${ev.event}${dataStr}`);
          }
        } else {
          console.warn(`    (no pipeline events recorded)`);
        }
        if (stepReport.blackoutDetails.length > 0) {
          console.warn(`  First blackout frame:`, JSON.stringify(stepReport.blackoutDetails[0]));
          console.warn(`  Last blackout frame:`, JSON.stringify(stepReport.blackoutDetails[stepReport.blackoutDetails.length - 1]));
        }
      }
    }

    console.log(`\n======================================================`);
    console.log(`[REPLAY COMPLETE] Executed ${scenario.actions.length} action(s).`);
    console.log(`Total blackout frames detected: ${totalBlackoutFrames}`);
    console.log(`======================================================\n`);

    expect(totalBlackoutFrames).toBe(0);
  });
});
