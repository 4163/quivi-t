// Agent-friendly e2e wrapper: cleans stale processes, relaunches de-elevated
// when elevated, runs the suite with output to a file, enforces a timeout with
// full cleanup, and prints a short summary. Exit codes: 0 pass, 1 tests
// failed, 2 infrastructure (elevated shell, leftover lock, timeout).
// Extra flags (--split, --layout, --timeout, --replay) are consumed here;
// anything else goes straight through to the child. --replay switches the
// child from scripts/e2e.js to e2e/replay-diagnostics/cli.js for replay and
// diagnose runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ELEVATED_MESSAGE =
  'E2E runs under an elevated shell. WebView2 remote debugging does not attach there; re-run from a non-elevated terminal.';
const PROCESS_NAMES = 'tauri-app,tauri-driver,msedgedriver,msedgewebview2,msedge';

function isElevated() {
  if (process.platform !== 'win32' || process.env.E2E_ALLOW_ELEVATED) {
    return false;
  }
  try {
    const out = spawnSync('whoami', ['/groups'], { encoding: 'utf8' }).stdout || '';
    return out.includes('S-1-16-12288') || out.includes('S-1-16-16384');
  } catch {
    return false;
  }
}

function killStale() {
  if (process.platform !== 'win32') {
    return;
  }
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Stop-Process -Name ${PROCESS_NAMES} -Force -ErrorAction SilentlyContinue`],
    { stdio: 'ignore' }
  );
}

function liveProcesses() {
  if (process.platform !== 'win32') {
    return '';
  }
  const check = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-Process -Name ${PROCESS_NAMES} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName`,
    ],
    { encoding: 'utf8' }
  );
  return [...new Set((check.stdout || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean))].join(', ');
}

function summarize(logText) {
  const hits = [];
  for (const line of logText.split(/\r?\n/)) {
    if (
      /passing|failing|Spec Files|session not created|Request timed out|E2E runs under an elevated shell|Failed to create a session|DIAGNOSTICS|Blackout|Anomal/.test(
        line
      )
    ) {
      hits.push(line.trim().slice(0, 200));
    }
  }
  const tail = hits.slice(-12);
  return tail.length > 0 ? tail : ['(no summary lines found; see full log)'];
}

const rawArgs = process.argv.slice(2);
let layout = null;
let timeoutMs = 300000;
let replay = false;
const passthrough = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--layout' && i + 1 < rawArgs.length) {
    layout = rawArgs[++i];
  } else if (rawArgs[i] === '--split') {
    layout = 'split';
  } else if (rawArgs[i] === '--timeout' && i + 1 < rawArgs.length) {
    timeoutMs = Number(rawArgs[++i]) || timeoutMs;
  } else if (rawArgs[i] === '--replay') {
    replay = true;
  } else {
    passthrough.push(rawArgs[i]);
  }
}

const childArgs = replay ? ['e2e/replay-diagnostics/cli.js'] : ['scripts/e2e.js'];
if (layout && !replay) {
  childArgs.push('--layout', layout);
}
childArgs.push(...passthrough);

if (isElevated()) {
  if (process.env.E2E_NO_DEELEVATE || process.env.E2E_DEELEVATED) {
    console.error(ELEVATED_MESSAGE);
    process.exit(2);
  }
  console.error('[e2e-agent] elevated shell; relaunching de-elevated...');
  const res = spawnSync(
    'python',
    ['scripts/e2e-de_elevated.py', '--cwd', repoRoot, '--', 'node', 'scripts/e2e-agent.js', ...rawArgs],
    { cwd: repoRoot, stdio: 'inherit', shell: false, timeout: timeoutMs + 60000 }
  );
  process.exit(res.status ?? 2);
}

killStale();
const survivors = liveProcesses();
if (survivors.includes('tauri-app') || survivors.includes('msedgewebview2')) {
  console.error(`Stale app processes survived cleanup (${survivors}); close all QuiviT windows and retry.`);
  process.exit(2);
}

const logDir = path.join(repoRoot, 'e2e', '.agent-logs');
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(logDir, `e2e-agent-${stamp}.log`);

const res = spawnSync('node', childArgs, {
  cwd: repoRoot,
  timeout: timeoutMs,
  killSignal: 'SIGTERM',
  shell: false,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

writeFileSync(logPath, (res.stdout || '') + (res.stderr || ''));

killStale();

let exitCode = res.status ?? 1;
let summaryLines;
if (res.error && res.error.code === 'ETIMEDOUT') {
  summaryLines = [`Timed out after ${timeoutMs}ms; processes cleaned up.`];
  exitCode = 2;
} else {
  summaryLines = summarize((res.stdout || '') + (res.stderr || ''));
}
console.log(`[e2e-agent] exit=${exitCode} log=${logPath}`);
for (const line of summaryLines) {
  console.log(`[e2e-agent] ${line}`);
}
process.exit(exitCode);
