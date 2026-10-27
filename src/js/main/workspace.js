import { Core } from '../core.js';
import { dockWorkspaceSurface, isWorkspaceDetached } from '../services/workspaceLayout.js';
import { workspaceSurface } from '../shared/workspaceHost.js';
import { forgetWorkspacePeer, windowPopups, workspacePopupUrl } from '../shared/workspaceSession.js';

export function initWorkspace({ onDetachedClose }) {
  const workspace = document.getElementById('workspace');
  let running = false;
  let dirty = false;
  let opened = false;
  let resolveClose = null;
  const label = 'workspace-file-list';

  function dock(surface) {
    const layout = dockWorkspaceSurface(Core.getState().workspaceLayout, surface);
    Core.setWorkspacePosition(surface, layout[surface], { persist: true });
  }

  async function reconcile() {
    dirty = true;
    if (running || workspaceSurface) return;
    running = true;
    try {
      while (dirty) {
        dirty = false;
        const detached = isWorkspaceDetached(Core.getState().workspaceLayout);
        if (detached === opened) continue;
        try {
          if (detached) {
            if (window.__TAURI__) {
              await window.__TAURI__.core.invoke('open_workspace_window', { surface: 'fileList' });
            } else {
              const popup = window.open(workspacePopupUrl('fileList'), label, 'popup,width=440,height=650');
              if (!popup) throw new Error('Allow popups to detach this panel');
              windowPopups.set(label, popup);
            }
          } else {
            const closed = new Promise(resolve => { resolveClose = resolve; });
            if (window.__TAURI__) await window.__TAURI__.core.invoke('close_workspace_window', { surface: 'fileList' });
            else windowPopups.get(label)?.close();
            await closed;
            windowPopups.delete(label);
            forgetWorkspacePeer(label);
          }
          opened = detached;
        } catch (error) {
          resolveClose = null;
          console.error('[Workspace] Unable to change panel window:', error);
          if (detached) {
            dock('fileList');
            window.alert(`Unable to detach File List. ${error}`);
          }
        }
      }
    } finally { running = false; }
  }

  function paint(state) {
    workspace.dataset.fileListPosition = state.workspaceLayout.fileList;
    workspace.dataset.viewportPosition = state.workspaceLayout.viewport;
    reconcile();
  }
  Core.onStateChange(paint);
  paint(Core.getState());
  window.addEventListener('quivit-workspace-closed', event => {
    if (event.detail !== 'workspace-file-list') return;
    opened = false;
    if (resolveClose) {
      resolveClose();
      resolveClose = null;
      return;
    }
    if (isWorkspaceDetached(Core.getState().workspaceLayout)) onDetachedClose();
  });
  if (!window.__TAURI__ && !workspaceSurface) {
    const timer = setInterval(() => {
      for (const [label, popup] of windowPopups) {
        if (!popup.closed) continue;
        windowPopups.delete(label);
        forgetWorkspacePeer(label);
        window.dispatchEvent(new CustomEvent('quivit-workspace-closed', { detail: label }));
      }
    }, 500);
    window.addEventListener('pagehide', () => clearInterval(timer));
  }
}
