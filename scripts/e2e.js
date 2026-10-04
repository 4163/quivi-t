// Runs the wdio suite with the config folder and layout picked explicitly.
// --split selects the split-files layout, otherwise one-file portable.
// --layout <split|portable> still works; anything else after the flags
// passes straight through to wdio (e.g. --spec).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

const layoutIdx = args.indexOf('--layout');
let layout = 'portable';
if (args.includes('--split')) {
  layout = 'split';
  args.splice(args.indexOf('--split'), 1);
} else if (layoutIdx !== -1) {
  layout = args[layoutIdx + 1] || 'portable';
  args.splice(layoutIdx, 2);
}
if (layout !== 'split' && layout !== 'portable') {
  console.error(`Unknown layout "${layout}". Use --layout split or --layout portable.`);
  process.exit(2);
}
process.env.E2E_LAYOUT = layout;

// Agent mode: same suite with stale-process cleanup, log file, timeout,
// and a short summary. Hand off to the agent runner with this flag stripped.
if (args.includes('--agent')) {
  const agentArgs = args.filter((a) => a !== '--agent');
  const res = spawnSync('node', ['scripts/e2e-agent.js', '--layout', layout, ...agentArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  process.exit(res.status ?? 1);
}

const res = spawnSync('npx', ['wdio', 'run', 'wdio.conf.js', ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
});
process.exit(res.status ?? 1);
