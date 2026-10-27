import { initWorkspaceSession } from '../shared/workspaceSession.js';

await initWorkspaceSession();
await import('./main.js');
