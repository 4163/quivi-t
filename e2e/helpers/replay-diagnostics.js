import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const investigationFile = path.resolve(__dirname, '../replay-diagnostics/investigation.js');

let diagnosticsModule;
if (fs.existsSync(investigationFile)) {
  console.log('[DIAGNOSTICS] Active probe engine: investigation.js (iterative investigation copy)');
  diagnosticsModule = await import('../replay-diagnostics/investigation.js');
} else {
  diagnosticsModule = await import('../replay-diagnostics/base.js');
}

export const initReplayDiagnostics = diagnosticsModule.initReplayDiagnostics;
