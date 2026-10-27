export const WORKSPACE_SURFACES = [
  { id: 'fileList', label: 'File List', window: 'file-list' },
  { id: 'viewport', label: 'Viewport', window: 'viewport' }
];

export const WORKSPACE_POSITIONS = ['left', 'right', 'top', 'bottom', 'detached'];
export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({ fileList: 'left', viewport: 'right' });
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

export function isWorkspaceDetached(layout) {
  return layout?.fileList === 'detached' || layout?.viewport === 'detached';
}

export function workspacePositionLabel(position) {
  return WORKSPACE_POSITIONS.includes(position) ? position[0].toUpperCase() + position.slice(1) : '';
}

export function normalizeWindowMenuVisibility(visibility, legacyVisible = true) {
  return Object.fromEntries(['main', 'fileList'].map(role => [
    role, typeof visibility?.[role] === 'boolean' ? visibility[role] : legacyVisible !== false
  ]));
}

export function normalizeWorkspaceLayout(layout) {
  if (isWorkspaceDetached(layout)) return { fileList: 'detached', viewport: 'detached' };
  const fileList = WORKSPACE_POSITIONS.includes(layout?.fileList) ? layout.fileList : 'left';
  return { fileList, viewport: OPPOSITE[fileList] };
}

export function relocateWorkspace(layout, surface, position) {
  const next = normalizeWorkspaceLayout(layout);
  if (!WORKSPACE_SURFACES.some(item => item.id === surface) || !WORKSPACE_POSITIONS.includes(position)) return next;
  const other = surface === 'fileList' ? 'viewport' : 'fileList';
  next[surface] = position;
  if (position !== 'detached') next[other] = OPPOSITE[position];
  else next[other] = 'detached';
  return next;
}

export function dockWorkspaceSurface(layout, surface) {
  const other = surface === 'fileList' ? 'viewport' : 'fileList';
  return relocateWorkspace(layout, surface, OPPOSITE[layout?.[other]] || DEFAULT_WORKSPACE_LAYOUT[surface]);
}
