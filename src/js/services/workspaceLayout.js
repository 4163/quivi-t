export const WORKSPACE_SURFACES = [
  { id: 'fileList', label: 'File List', window: 'file-list' },
  { id: 'viewport', label: 'Viewport', window: 'viewport' }
];

export const WORKSPACE_POSITIONS = ['left', 'right', 'top', 'bottom', 'detached'];
export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({ fileList: 'left', viewport: 'right' });
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

export function normalizeWorkspaceLayout(layout) {
  const fileList = WORKSPACE_POSITIONS.includes(layout?.fileList) ? layout.fileList : 'left';
  if (fileList !== 'detached') {
    return { fileList, viewport: layout?.viewport === 'detached' ? 'detached' : OPPOSITE[fileList] };
  }
  const viewport = OPPOSITE[layout?.viewport] ? layout.viewport : 'right';
  return { fileList, viewport };
}

export function relocateWorkspace(layout, surface, position) {
  const next = normalizeWorkspaceLayout(layout);
  if (!WORKSPACE_SURFACES.some(item => item.id === surface) || !WORKSPACE_POSITIONS.includes(position)) return next;
  const other = surface === 'fileList' ? 'viewport' : 'fileList';
  next[surface] = position;
  if (position !== 'detached') next[other] = OPPOSITE[position];
  else if (next[other] === 'detached') next[other] = DEFAULT_WORKSPACE_LAYOUT[other];
  return next;
}

export function dockWorkspaceSurface(layout, surface) {
  const other = surface === 'fileList' ? 'viewport' : 'fileList';
  return relocateWorkspace(layout, surface, OPPOSITE[layout?.[other]] || DEFAULT_WORKSPACE_LAYOUT[surface]);
}
