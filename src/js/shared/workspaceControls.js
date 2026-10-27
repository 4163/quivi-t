import { ACTION_MAP, dispatch } from '../services/actions.js';
import { Core } from '../core.js';
import { workspaceSurface, hostsWorkspaceSurface } from './workspaceHost.js';
import { registerWorkspaceHandlers, requestWorkspace, createWorkspaceService } from './workspaceSession.js';

export function createWorkspaceControls({ actionCtx, Viewer, strip, getVisibleImageIndices }) {
  let remoteVisibleIndices = [];
  let importActivity = { importing: false, phase: 'idle', dropId: null };
  window.addEventListener('quivit-workspace-strip-info', event => { remoteVisibleIndices = event.detail || []; });

  function dispatchAction(id, payload) {
    const action = ACTION_MAP.get(id);
    const owner = typeof action?.owner === 'function' ? action.owner(actionCtx, payload) : action?.owner || 'main';
    if (!workspaceSurface || owner === 'window') return dispatch(id, payload, actionCtx).catch(console.error);
    const forwarded = payload ? { wheel: payload.wheel, clientX: payload.clientX, clientY: payload.clientY, fileList: payload.fileList } : null;
    if (forwarded?.wheel) forwarded.clientX = forwarded.clientY = undefined;
    return requestWorkspace('main', 'action', 'run', [id, forwarded]).catch(console.error);
  }

  function publishStripInfo() {
    if (!hostsWorkspaceSurface('viewport')) return;
    const indices = getVisibleImageIndices();
    window.dispatchEvent(new CustomEvent('quivit-workspace-strip-info', { detail: indices }));
  }

  return {
    dispatchAction,
    panBy(dx, dy) {
      if (hostsWorkspaceSurface('viewport')) Viewer.panBy(dx, dy);
      else requestWorkspace('main', 'viewer', 'panBy', [dx, dy]).catch(console.error);
    },
    stripCall(method, ...args) {
      if (hostsWorkspaceSurface('viewport')) return strip[method](...args);
      requestWorkspace('main', 'strip', method, args).catch(console.error);
      return true;
    },
    visibleIndices: () => hostsWorkspaceSurface('viewport') ? getVisibleImageIndices() : remoteVisibleIndices,
    createImportActions(createLocal) {
      const local = createLocal();
      if (!workspaceSurface) {
        local.subscribe(activity => {
          importActivity = activity;
          window.dispatchEvent(new CustomEvent('quivit-workspace-import-activity', { detail: activity }));
        });
      } else {
        local.subscribe = listener => {
          listener(importActivity);
          const onActivity = event => { importActivity = event.detail; listener(event.detail); };
          window.addEventListener('quivit-workspace-import-activity', onActivity);
          return () => window.removeEventListener('quivit-workspace-import-activity', onActivity);
        };
      }
      return createWorkspaceService('import', local, ['subscribe']);
    },
    connect({ importActions, UrlLoader }) {
      registerWorkspaceHandlers({
        action: { run: async (id, payload) => {
          if (ACTION_MAP.get(id)?.focusOwner) await window.__TAURI__?.window.getCurrentWindow().setFocus().catch(console.error);
          return dispatchAction(id, payload);
        } },
        viewer: { panBy: (...args) => Viewer.panBy(...args) },
        strip,
        url: Object.fromEntries(Object.entries(UrlLoader).filter(([method, value]) => method !== 'init' && typeof value === 'function'))
      });
      if (workspaceSurface) importActions.getActivity().then(activity => {
        window.dispatchEvent(new CustomEvent('quivit-workspace-import-activity', { detail: activity }));
      }).catch(console.error);
      Core.onStateChange(publishStripInfo);
      window.addEventListener('quivit-manhwa-settle', publishStripInfo);
    }
  };
}
