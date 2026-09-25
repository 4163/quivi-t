// Runs the wdio suite with the config folder and layout picked explicitly.
// Layouts: split (release default) or portable (one file). Anything else
// after the flags passes straight through to wdio (e.g. --spec).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

const layoutIdx = args.indexOf('--layout');
let layout = 'portable';
if (layoutIdx !== -1) {
  layout = args[layoutIdx + 1] || 'portable';
  args.splice(layoutIdx, 2);
}
if (layout !== 'split' && layout !== 'portable') {
  console.error(`Unknown layout "${layout}". Use --layout split or --layout portable.`);
  process.exit(2);
}
process.env.E2E_LAYOUT = layout;

const res = spawnSync('npx', ['wdio', 'run', 'wdio.conf.js', ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
});
process.exit(res.status ?? 1);
