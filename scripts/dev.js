// Launches `tauri dev` with an isolated config folder so dev runs never
// touch roaming user data or fight the test harness over target/debug.
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

if (!process.env.QUIVIT_CONFIG_DIR) {
  process.env.QUIVIT_CONFIG_DIR = path.join(repoRoot, '.dev-config');
}
mkdirSync(process.env.QUIVIT_CONFIG_DIR, { recursive: true });

const wantPortable = args.includes('--portable');
if (wantPortable) process.env.QUIVIT_PORTABLE = '1';
const passthrough = args.filter((a) => a !== '--portable' && a !== '--print-dir');

if (args.includes('--print-dir')) {
  console.log(process.env.QUIVIT_CONFIG_DIR);
  process.exit(0);
}

const res = spawnSync('npx', ['tauri', 'dev', ...passthrough], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
});
process.exit(res.status ?? 1);
