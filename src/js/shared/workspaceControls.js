import { ACTION_REGISTRY, dispatch } from '../services/actions.js';
import { Core } from '../core.js';
import { workspaceSurface, hostsWorkspaceSurface } from './workspaceHost.js';
import { registerWorkspaceHandlers, requestWorkspace } from './workspaceSession.js';

const viewportActionIds = new Set(ACTION_REGISTRY.filter(action => ['Zoom', 'Pan', 'Rotation'].includes(action.category)).map(action => action.id));
viewportActionIds.add('cmd-toggle-audio');
viewportActionIds.add('cmd-toggle-cursor-autohide');
const SESSION_ACTIONS = new Set(['cmd-history-back', 'cmd-history-forward', 'cmd-quit']);

export function createWorkspaceControls({ actionCtx, Viewer, strip, getVisibleImageIndices }) {
  let remoteVisibleIndices = [];
  let importActivity = { importing: false, phase: 'idle', dropId: null };
  window.addEventListener('quivit-workspace-strip-info', event => { remoteVisibleIndices = event.detail || []; });

  function dispatchAction(id, payload) {
    let target = workspaceSurface && SESSION_ACTIONS.has(id) ? 'main' : null;
    const savedItemFocused = !payload?.fileList && (actionCtx.isFavoritesFocused() || actionCtx.isLibraryFocused());
    const stripNavigation = ['cmd-next', 'cmd-prev'].includes(id) && Core.getState().manhwaEnabled && !savedItemFocused;
    if ((viewportActionIds.has(id) || stripNavigation) && !hostsWorkspaceSurface('viewport')) target = 'main';
    if (!target) return dispatch(id, payload, actionCtx).catch(console.error);
    const forwarded = payload ? { wheel: payload.wheel, clientX: payload.clientX, clientY: payload.clientY, fileList: payload.fileList } : null;
    if (forwarded?.wheel && ['cmd-zoom-in', 'cmd-zoom-out'].includes(id)) forwarded.wheel = false;
    return requestWorkspace(target, 'action', 'run', [id, forwarded]).catch(console.error);
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
      if (!workspaceSurface) {
        const actions = createLocal();
        actions.subscribe(activity => {
          importActivity = activity;
          window.dispatchEvent(new CustomEvent('quivit-workspace-import-activity', { detail: activity }));
        });
        return actions;
      }
      return {
        subscribe(listener) {
          listener(importActivity);
          const onActivity = event => { importActivity = event.detail; listener(event.detail); };
          window.addEventListener('quivit-workspace-import-activity', onActivity);
          return () => window.removeEventListener('quivit-workspace-import-activity', onActivity);
        },
        openUrl: url => requestWorkspace('main', 'import', 'openUrl', [url]),
        openPath: path => requestWorkspace('main', 'import', 'openPath', [path])
      };
    },
    connect({ importActions, UrlLoader }) {
      registerWorkspaceHandlers({
        action: { run: (id, payload) => dispatchAction(id, payload) },
        viewer: { panBy: (...args) => Viewer.panBy(...args) },
        strip,
        import: { openUrl: url => importActions.openUrl(url), openPath: path => importActions.openPath(path), activity: () => importActivity },
        url: Object.fromEntries(['loadUrl', 'retryGalleryDownload', 'setVisibleRange', 'setDisplayOrder',
          'cancelGalleryDownloads', 'forgetDeletedLibraryEntry', 'getWorkspaceDownloadState'].map(method => [method, (...args) => UrlLoader[method](...args)]))
      });
      if (workspaceSurface) requestWorkspace('main', 'import', 'activity').then(activity => {
        window.dispatchEvent(new CustomEvent('quivit-workspace-import-activity', { detail: activity }));
      }).catch(console.error);
      Core.onStateChange(publishStripInfo);
      window.addEventListener('quivit-manhwa-settle', publishStripInfo);
    }
  };
}
