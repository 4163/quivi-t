#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const scenariosDir = path.resolve(__dirname, '../scenarios');
const reportsDir = path.resolve(__dirname, 'reports');

function printUsage() {
  console.log(`
QuiviT Replay Diagnostics CLI

Usage:
  node e2e/replay-diagnostics/cli.js [scenario] [options]
  npm run diagnose -- [scenario] [options]

Options:
  --scenario <name|path>   Target scenario name or JSON path (default: last-recording)
  --pause <ms>             Step pause duration in ms (default: 250)
  --verbose                Display full event timeline for all steps
  --investigate            Create/use investigation copy of base.js for iterative probing
  --clean                  Remove investigation.js after diagnosis
  --inspect [scenario]     Inspect the latest or specified report without re-running
  --list                   List available scenarios in e2e/scenarios/
  --help                   Display this help message

Examples:
  node e2e/replay-diagnostics/cli.js
  node e2e/replay-diagnostics/cli.js sample-navigation --pause 300
  node e2e/replay-diagnostics/cli.js last-recording --verbose
  node e2e/replay-diagnostics/cli.js --inspect
`);
}

function listScenarios() {
  if (!fs.existsSync(scenariosDir)) {
    console.log('No scenarios directory found.');
    return;
  }
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No recorded scenarios found in e2e/scenarios/.');
    return;
  }
  console.log('Available scenarios:');
  for (const f of files) {
    const fullPath = path.join(scenariosDir, f);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      console.log(`  - ${f.replace('.json', '')} (${data.actions?.length || 0} actions, recorded ${data.recordedAt || 'unknown'})`);
    } catch {
      console.log(`  - ${f}`);
    }
  }
}

function inspectReport(targetScenario) {
  if (!fs.existsSync(reportsDir)) {
    console.error('No reports directory found.');
    process.exit(1);
  }

  let reportFile = null;
  if (targetScenario) {
    const candidate = path.join(reportsDir, `${targetScenario}-report.json`);
    if (fs.existsSync(candidate)) reportFile = candidate;
  }

  if (!reportFile) {
    const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-report.json'));
    if (files.length === 0) {
      console.error('No diagnostic reports found in e2e/replay-diagnostics/reports/.');
      process.exit(1);
    }
    files.sort((a, b) => {
      return fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs;
    });
    reportFile = path.join(reportsDir, files[0]);
  }

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
  displayReportSummary(report, reportFile);
}

function displayReportSummary(report, reportFile) {
  console.log(`\n======================================================`);
  console.log(`DIAGNOSTIC REPORT SUMMARY`);
  console.log(`Scenario:     ${report.scenario}`);
  console.log(`Timestamp:    ${report.timestamp}`);
  console.log(`Report File:  ${reportFile}`);
  console.log(`Total Steps:  ${report.steps?.length || 0}`);
  console.log(`Blackout:     ${report.totalBlackoutFrames} frame(s)`);
  console.log(`Anomalies:    ${report.totalAnomalies} event(s)`);
  console.log(`Jank:         ${report.totalJankFrames} frame(s)`);
  console.log(`======================================================\n`);

  if (report.totalBlackoutFrames > 0) {
    console.error(`[CRITICAL] Blackout / Blank Flicker Frames Detected:`);
    for (const step of report.steps) {
      if (step.blackoutFrameCount > 0) {
        console.error(`  Step ${step.stepIndex} [${step.actionId}] (${step.filename || 'N/A'}):`);
        for (const b of step.blackoutDetails || []) {
          console.error(`    - At +${b.t}ms: activeSrc=${b.activeSrc || 'none'} (complete=${b.activeComplete}), bridgeSrc=${b.bridgeSrc || 'none'}, lanczosReady=${b.lanczosReady}, filterReady=${b.filterReady}`);
        }
      }
    }
    console.log();
  }

  if (report.totalAnomalies > 0) {
    console.warn(`[WARNING] Pipeline Anomalies Detected:`);
    for (const step of report.steps) {
      if (step.anomalies && step.anomalies.length > 0) {
        const nonBlackout = step.anomalies.filter((a) => a.type !== 'blackout');
        if (nonBlackout.length > 0) {
          console.warn(`  Step ${step.stepIndex} [${step.actionId}] (${step.filename || 'N/A'}):`);
          for (const a of nonBlackout) {
            console.warn(`    - At +${a.t}ms [${a.type}]: ${JSON.stringify(a)}`);
          }
        }
      }
    }
    console.log();
  }

  if (report.totalBlackoutFrames === 0 && report.totalAnomalies === 0) {
    console.log(`[PASS] Pipeline executed cleanly. Zero blackouts, zero anomalies.\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (args.includes('--list')) {
    listScenarios();
    return;
  }

  if (args.includes('--inspect')) {
    const inspectIdx = args.indexOf('--inspect');
    const target = args[inspectIdx + 1] && !args[inspectIdx + 1].startsWith('-') ? args[inspectIdx + 1] : null;
    inspectReport(target);
    return;
  }

  const investigationPath = path.resolve(__dirname, 'investigation.js');
  const basePath = path.resolve(__dirname, 'base.js');

  if (args.includes('--clean')) {
    if (fs.existsSync(investigationPath)) {
      fs.unlinkSync(investigationPath);
      console.log('[DIAGNOSTICS] Removed investigation copy: e2e/replay-diagnostics/investigation.js');
    }
    const hasRunTarget = args.some((a) => !a.startsWith('-') || a.startsWith('--scenario'));
    if (!hasRunTarget) return;
  }

  if (args.includes('--investigate')) {
    if (!fs.existsSync(investigationPath)) {
      fs.copyFileSync(basePath, investigationPath);
      console.log('[DIAGNOSTICS] Created investigation copy: e2e/replay-diagnostics/investigation.js');
    } else {
      console.log('[DIAGNOSTICS] Using existing investigation copy: e2e/replay-diagnostics/investigation.js');
    }
  }

  let scenario = 'last-recording';
  let pause = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scenario' || arg === '-s') {
      scenario = args[++i];
    } else if (arg.startsWith('--scenario=')) {
      scenario = arg.substring(11);
    } else if (arg === '--pause' || arg === '-p') {
      pause = args[++i];
    } else if (arg.startsWith('--pause=')) {
      pause = arg.substring(8);
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (!arg.startsWith('-') && i === 0) {
      scenario = arg;
    }
  }

  const env = {
    ...process.env,
    SCENARIO: scenario,
  };
  if (pause) env.STEP_PAUSE_MS = pause;
  if (verbose) env.VERBOSE = '1';

  if (fs.existsSync(investigationPath)) {
    console.log('\n************************************************************');
    console.log('[NOTICE] ACTIVE INVESTIGATION OVERRIDE:');
    console.log('Engine: e2e/replay-diagnostics/investigation.js');
    console.log('(base.js is shadowed. Use --clean when finished)');
    console.log('************************************************************\n');
  } else {
    console.log('[DIAGNOSTICS] Engine: base.js (baseline)');
  }

  console.log(`[DIAGNOSTICS] Launching replay for scenario "${scenario}"...`);
  if (pause) console.log(`[DIAGNOSTICS] Step pause: ${pause}ms`);
  if (verbose) console.log(`[DIAGNOSTICS] Verbose mode enabled`);

  const wdioBin = path.resolve(rootDir, 'node_modules/.bin/wdio');
  const isWindows = process.platform === 'win32';
  const wdioCmd = isWindows ? 'npx.cmd' : 'npx';
  const wdioArgs = ['wdio', 'run', 'wdio.conf.js', '--spec', 'e2e/specs/replay.e2e.js'];

  const child = spawn(wdioCmd, wdioArgs, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: true,
  });

  child.on('close', (code) => {
    const scenarioName = path.basename(scenario, '.json');
    const reportFile = path.join(reportsDir, `${scenarioName}-report.json`);

    if (fs.existsSync(reportFile)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
        displayReportSummary(report, reportFile);

        if (report.totalBlackoutFrames > 0 || report.totalAnomalies > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.warn('Could not parse report file:', err);
      }
    }

    process.exit(code);
  });
}

main();
