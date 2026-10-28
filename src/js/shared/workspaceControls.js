import { ACTION_MAP, dispatch } from '../services/actions.js';
import { Core } from '../core.js';
import { workspaceSurface, hostsWorkspaceSurface } from './workspaceHost.js';
import {
  registerWorkspaceHandlers,
  requestWorkspace,
  createWorkspaceService,
  registerStripVisibleIndicesProvider,
  getSessionStripVisibleIndices,
  getLastInitiator,
  setLastInitiator
} from './workspaceSession.js';

export function createWorkspaceControls({ actionCtx, Viewer, strip, getVisibleImageIndices, revealListTop, focusFileList }) {
  let remoteVisibleIndices = getSessionStripVisibleIndices() || [];
  let remoteFileListAtTop = false;
  let localFileListAtTop = true;
  let fileListDetached = !hostsWorkspaceSurface('fileList');
  let scrollReportRevision = 0;
  let revealPending = null;
  let importActivity = { importing: false, phase: 'idle', dropId: null };

  if (hostsWorkspaceSurface('viewport') && typeof getVisibleImageIndices === 'function') {
    registerStripVisibleIndicesProvider(getVisibleImageIndices);
  }

  window.addEventListener('quivit-workspace-strip-info', event => {
    remoteVisibleIndices = event.detail || [];
    if (workspaceSurface) {
      window.dispatchEvent(new CustomEvent('quivit-manhwa-settle'));
    }
  });

  function dispatchAction(id, payload) {
    const action = ACTION_MAP.get(id);
    const owner = typeof action?.owner === 'function' ? action.owner(actionCtx, payload) : action?.owner || 'main';
    if (!workspaceSurface || owner === 'window') {
      if (!workspaceSurface) setLastInitiator('main');
      return dispatch(id, payload, actionCtx).catch(console.error);
    }
    const forwarded = payload ? { wheel: payload.wheel, clientX: payload.clientX, clientY: payload.clientY, fileList: payload.fileList } : {};
    if (forwarded.wheel) forwarded.clientX = forwarded.clientY = undefined;
    forwarded.initiator = 'workspace-file-list';
    return requestWorkspace('main', 'action', 'run', [id, forwarded]).catch(console.error);
  }

  function publishStripInfo() {
    if (!hostsWorkspaceSurface('viewport') || typeof getVisibleImageIndices !== 'function') return;
    const indices = getVisibleImageIndices();
    window.dispatchEvent(new CustomEvent('quivit-workspace-strip-info', { detail: indices }));
  }

  function handleRevealListTop() {
    if (hostsWorkspaceSurface('fileList')) {
      return revealListTop?.() ?? true;
    }
    if (revealPending) return false;
    const wasAtTop = remoteFileListAtTop;
    const revision = scrollReportRevision;
    const request = requestWorkspace('workspace-file-list', 'filePanel', 'revealListTop');
    revealPending = request;
    request.then(() => {
      if (revealPending === request && revision === scrollReportRevision) remoteFileListAtTop = true;
    }).catch(console.error).finally(() => {
      if (revealPending === request) revealPending = null;
    });
    return wasAtTop;
  }

  function reportFileListScroll(isAtTop) {
    localFileListAtTop = isAtTop;
    if (hostsWorkspaceSurface('fileList') && workspaceSurface) {
      requestWorkspace('main', 'filePanel', 'setFileListAtTop', [isAtTop]).catch(console.error);
    }
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
    revealListTop: handleRevealListTop,
    reportFileListScroll,
    restoreFocus(target = 'main') {
      if (target !== 'workspace-file-list' || hostsWorkspaceSurface('fileList')) {
        if (hostsWorkspaceSurface('fileList')) {
          focusFileList?.();
        } else {
          document.getElementById('viewport')?.focus();
        }
        return Promise.resolve();
      }
      if (!workspaceSurface) {
        window.__TAURI__?.core?.invoke?.('plugin:window|set_focus', { label: target }).catch(() => {});
        return requestWorkspace('workspace-file-list', 'filePanel', 'focus').catch(console.error);
      }
      return Promise.resolve();
    },
    getLastInitiator,
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
      const service = createWorkspaceService('import', local, ['subscribe']);
      if (workspaceSurface) return service;
      return {
        ...service,
        openUrl: (...args) => { setLastInitiator('main'); return service.openUrl(...args); },
        openPath: (...args) => { setLastInitiator('main'); return service.openPath(...args); },
        acceptDrop: (...args) => { setLastInitiator('main'); return service.acceptDrop(...args); },
        completeDrop: (...args) => { setLastInitiator('main'); return service.completeDrop(...args); }
      };
    },
    connect({ importActions, UrlLoader }) {
      registerWorkspaceHandlers({
        action: { run: async (id, payload) => {
          if (payload?.initiator) setLastInitiator(payload.initiator);
          if (ACTION_MAP.get(id)?.focusOwner) await window.__TAURI__?.window.getCurrentWindow().setFocus().catch(console.error);
          return dispatchAction(id, payload);
        } },
        viewer: { panBy: (...args) => Viewer.panBy(...args) },
        strip,
        filePanel: workspaceSurface ? {
          revealListTop: () => hostsWorkspaceSurface('fileList') ? revealListTop?.() ?? true : true,
          focus: async () => {
            if (window.__TAURI__) {
              await window.__TAURI__.window.getCurrentWindow().setFocus().catch(console.error);
            } else {
              window.focus?.();
            }
            focusFileList?.();
          }
        } : {
          setFileListAtTop: isAtTop => {
            if (!hostsWorkspaceSurface('fileList')) {
              remoteFileListAtTop = isAtTop === true;
              scrollReportRevision++;
            }
          }
        },
        url: Object.fromEntries(Object.entries(UrlLoader).filter(([method, value]) => method !== 'init' && typeof value === 'function'))
      });
      if (workspaceSurface) {
        importActions.getActivity().then(activity => {
          window.dispatchEvent(new CustomEvent('quivit-workspace-import-activity', { detail: activity }));
        }).catch(console.error);
        if (hostsWorkspaceSurface('fileList')) {
          reportFileListScroll(localFileListAtTop);
        }
      }
      Core.onStateChange(() => {
        const detached = !hostsWorkspaceSurface('fileList');
        if (detached !== fileListDetached) {
          fileListDetached = detached;
          remoteFileListAtTop = false;
          scrollReportRevision++;
          revealPending = null;
        }
        publishStripInfo();
      });
      window.addEventListener('quivit-manhwa-settle', publishStripInfo);
    }
  };
}
