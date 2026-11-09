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

const DOCKED_POSITIONS = ['left', 'right', 'top', 'bottom'];

export function normalizeWorkspaceLayout(layout) {
  if (isWorkspaceDetached(layout)) {
    // `docked` remembers where the File List sat before detaching so closing
    // the detached window can put it back there.
    const docked = DOCKED_POSITIONS.includes(layout?.docked) ? layout.docked : DEFAULT_WORKSPACE_LAYOUT.fileList;
    return { fileList: 'detached', viewport: 'detached', docked };
  }
  const fileList = WORKSPACE_POSITIONS.includes(layout?.fileList) ? layout.fileList : 'left';
  return { fileList, viewport: OPPOSITE[fileList] };
}

export function relocateWorkspace(layout, surface, position) {
  const next = normalizeWorkspaceLayout(layout);
  if (!WORKSPACE_SURFACES.some(item => item.id === surface) || !WORKSPACE_POSITIONS.includes(position)) return next;
  if (position === 'detached') {
    if (isWorkspaceDetached(next)) return next;
    return { fileList: 'detached', viewport: 'detached', docked: next.fileList };
  }
  const fileList = surface === 'fileList' ? position : OPPOSITE[position];
  return { fileList, viewport: OPPOSITE[fileList] };
}

export function dockWorkspaceSurface(layout, surface) {
  const current = normalizeWorkspaceLayout(layout);
  const fileList = isWorkspaceDetached(current) ? current.docked : current.fileList;
  return relocateWorkspace(current, 'fileList', fileList);
}
