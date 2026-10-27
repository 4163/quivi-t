import { Core } from '../core.js';
import { isWorkspaceDetached } from '../services/workspaceLayout.js';

const requestedSurface = new URLSearchParams(window.location.search).get('surface');
export const workspaceSurface = requestedSurface === 'fileList' ? 'fileList' : null;
const EMPTY_LIST = [];

export function hostsWorkspaceSurface(surface, state = Core.getState()) {
  if (workspaceSurface) return workspaceSurface === surface && state.workspaceLayout?.[surface] === 'detached';
  return surface === 'viewport' || !isWorkspaceDetached(state.workspaceLayout);
}

function viewportState(state) {
  if (hostsWorkspaceSurface('viewport', state)) return state;
  return { ...state, mode: 'empty', src: '', list: EMPTY_LIST, index: -1, manhwaEnabled: false, isAnimated: false };
}

// Inactive renderers receive an empty view so their existing teardown paths
// release media and WebGL resources without changing the shared session.
export const ViewportCore = Object.create(Core);
ViewportCore.getState = () => viewportState(Core.getState());
ViewportCore.onStateChange = fn => Core.onStateChange(state => fn(viewportState(state)));
ViewportCore.setImageDimensions = (...args) => {
  if (hostsWorkspaceSurface('viewport')) return Core.setImageDimensions(...args);
};
ViewportCore.setState = (...args) => {
  if (hostsWorkspaceSurface('viewport')) return Core.setState(...args);
};
