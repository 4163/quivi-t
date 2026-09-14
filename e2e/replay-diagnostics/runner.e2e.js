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
const reportsDir = path.resolve(__dirname, 'reports');

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

describe('Replay Diagnostics Runner', function () {
  this.timeout(1800000); // 30 minutes

  it('executes recorded scenario and collects full pipeline identity telemetry', async function () {
    this.timeout(1800000);
    await menubarPage.ensureMainWindow();

    const rawScenario = process.env.SCENARIO || getCliArg('scenario') || 'last-recording';
    let targetFile = rawScenario;

    if (!path.isAbsolute(targetFile)) {
      const asScenarioFile = path.join(scenariosDir, targetFile.endsWith('.json') ? targetFile : `${targetFile}.json`);
      if (fs.existsSync(asScenarioFile)) {
        targetFile = asScenarioFile;
      } else if (fs.existsSync(path.resolve(process.cwd(), rawScenario))) {
        targetFile = path.resolve(process.cwd(), rawScenario);
      }
    }

    if (!fs.existsSync(targetFile)) {
      if (fs.existsSync(scenariosDir)) {
        const available = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
        if (available.length > 0) {
          targetFile = path.join(scenariosDir, available[0]);
          console.warn(`Scenario "${rawScenario}" not found. Falling back to "${available[0]}".`);
        }
      }
    }

    if (!fs.existsSync(targetFile)) {
      throw new Error(`No scenario file found to replay. Expected: ${targetFile}. Record one first using 'npm run test:record'.`);
    }

    const scenarioName = path.basename(targetFile, '.json');

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

    let initialPath = scenario.initialPath || scenario.initialState?.container || fixtures.testPng;
    if (!path.isAbsolute(initialPath)) {
      const projectRoot = path.resolve(__dirname, '../..');
      initialPath = path.resolve(projectRoot, initialPath);
    }

    // Ensure viewport and application DOM are ready
    await viewerPage.viewport.waitForDisplayed({ timeout: 15000 });

    // Load initial file into viewport
    await browser.execute(async (filePath) => {
      try {
        const { FsUtils } = await import('/js/fsUtils.js');
        if (FsUtils && typeof FsUtils.loadFile === 'function') {
          await FsUtils.loadFile(filePath, { preferInitial: true, restoreLastImage: false });
          return;
        }
      } catch {}
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

    // Inject diagnostic engine and active probes
    await browser.execute(initReplayDiagnostics);

    const reports = [];
    let totalBlackoutFrames = 0;
    let totalAnomalies = 0;
    let totalJankFrames = 0;

    const stepPauseMs = parseInt(process.env.STEP_PAUSE_MS || getCliArg('pause') || getCliArg('step-pause') || '250', 10);
    const isVerbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true' || Boolean(getCliArg('verbose'));

    for (let i = 0; i < scenario.actions.length; i++) {
      const stepItem = scenario.actions[i];
      const stepIndex = i + 1;
      const actionId = typeof stepItem === 'string' ? stepItem : stepItem.action;
      const actionContext = typeof stepItem === 'object' ? stepItem.context : null;

      // Start step frame monitor and probes
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
        await browser.execute(async (id, item) => {
          const el = document.getElementById(id);
          if (el) {
            el.click();
            return;
          }
          const { dispatch } = await import('/js/services/actions.js');
          if (typeof dispatch === 'function') {
            await dispatch(id, item?.payload, item?.context);
          }
        }, actionId, typeof stepItem === 'object' ? stepItem : null);
      }

      // Wait for image decode, scaling resampler, and paint transition
      await browser.pause(stepPauseMs);

      // Collect diagnostic report for this step
      const stepReport = await browser.execute(() => {
        return window.__QUIVIT_DIAGNOSTICS__.stopStep();
      });

      reports.push(stepReport);
      totalBlackoutFrames += stepReport.blackoutFrameCount;
      totalAnomalies += (stepReport.anomalyCount || 0);
      totalJankFrames += (stepReport.jankFrameCount || 0);

      const hasBlackout = stepReport.blackoutFrameCount > 0;
      const hasAnomalies = (stepReport.anomalyCount || 0) > 0;
      let flag = ' [OK]';
      if (hasBlackout) flag = ' [FLICKER DETECTED]';
      else if (hasAnomalies) flag = ' [ANOMALY DETECTED]';

      const filename = stepReport.filename || actionContext?.filename || 'N/A';
      const format = actionContext?.format ? ` [${actionContext.format.toUpperCase()}]` : '';
      const pipelineInfo = actionContext?.pipeline
        ? ` (scaling: ${actionContext.pipeline.scaling}, filter: ${actionContext.pipeline.filter})`
        : '';

      console.log(
        `Step ${stepIndex}/${scenario.actions.length} [${actionId}]: ${filename}${format}${pipelineInfo} ` +
        `-> ${stepReport.durationMs}ms, ${stepReport.frameCount} frames (${stepReport.jankFrameCount} jank)${flag}`
      );

      // Print anomaly details and timeline if detected or in verbose mode
      if (hasAnomalies || hasBlackout || isVerbose) {
        if (stepReport.anomalies && stepReport.anomalies.length > 0) {
          console.warn(`  Anomalies (${stepReport.anomalies.length}):`);
          for (const a of stepReport.anomalies) {
            console.warn(`    [+${a.t}ms] [${a.type}] ${JSON.stringify(a)}`);
          }
        }

        if (stepReport.events && stepReport.events.length > 0) {
          console.log(`  Event timeline (${stepReport.events.length} events):`);
          for (const ev of stepReport.events) {
            const dataStr = ev.data ? ` ${JSON.stringify(ev.data)}` : '';
            console.log(`    [+${ev.t}ms] [${ev.source}] ${ev.event}${dataStr}`);
          }
        }
      }
    }

    console.log(`\n======================================================`);
    console.log(`[REPLAY COMPLETE] Executed ${scenario.actions.length} action(s).`);
    console.log(`Total blackout frames: ${totalBlackoutFrames}`);
    console.log(`Total anomalies: ${totalAnomalies}`);
    console.log(`Total jank frames: ${totalJankFrames}`);
    console.log(`======================================================\n`);

    // Persist diagnostic report
    try {
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      const reportFile = path.join(reportsDir, `${scenarioName}-report.json`);
      fs.writeFileSync(reportFile, JSON.stringify({
        scenario: scenarioName,
        timestamp: new Date().toISOString(),
        totalBlackoutFrames,
        totalAnomalies,
        totalJankFrames,
        steps: reports,
      }, null, 2), 'utf-8');
      console.log(`Diagnostic report saved to: ${reportFile}\n`);
    } catch (err) {
      console.warn('Failed to save diagnostic report:', err);
    }

    expect(totalBlackoutFrames).toBe(0);
  });
});
