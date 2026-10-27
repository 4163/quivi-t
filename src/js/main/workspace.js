import { Core } from '../core.js';
import { WORKSPACE_SURFACES, dockWorkspaceSurface } from '../services/workspaceLayout.js';
import { workspaceSurface } from '../shared/workspaceHost.js';
import { forgetWorkspacePeer, windowPopups, workspacePopupUrl } from '../shared/workspaceSession.js';

export function initWorkspace() {
  const workspace = document.getElementById('workspace');
  let running = false;
  let dirty = false;
  const opened = new Set();

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
        for (const surface of WORKSPACE_SURFACES) {
          const label = `workspace-${surface.window}`;
          const detached = Core.getState().workspaceLayout[surface.id] === 'detached';
          if (detached === opened.has(surface.id)) continue;
          try {
            if (detached) {
              if (window.__TAURI__) {
                await window.__TAURI__.core.invoke('open_workspace_window', { surface: surface.id });
              } else {
                const popup = window.open(workspacePopupUrl(surface.id), label, 'popup,width=900,height=650');
                if (!popup) throw new Error('Allow popups to detach this panel');
                windowPopups.set(label, popup);
              }
              opened.add(surface.id);
            } else {
              if (window.__TAURI__) await window.__TAURI__.core.invoke('close_workspace_window', { surface: surface.id });
              else windowPopups.get(label)?.close();
              windowPopups.delete(label);
              forgetWorkspacePeer(label);
              opened.delete(surface.id);
            }
          } catch (error) {
            console.error('[Workspace] Unable to change panel window:', error);
            if (detached) {
              dock(surface.id);
              window.alert(`Unable to detach ${surface.label}. ${error}`);
            }
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
    const surface = WORKSPACE_SURFACES.find(item => `workspace-${item.window}` === event.detail);
    if (!surface) return;
    opened.delete(surface.id);
    if (Core.getState().workspaceLayout[surface.id] === 'detached') dock(surface.id);
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
