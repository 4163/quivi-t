const HISTORY_LIMIT = 100;

let backStack = [];
let forwardStack = [];

function emitChange() {
  window.dispatchEvent(new CustomEvent('quivit-history-changed'));
}

function selectedEntry(state) {
  return state.list?.[state.index] || null;
}

function entryKey(entry) {
  return entry ? `${entry.containerKind}:${entry.containerPath}` : '';
}

function sameContainer(a, b) {
  return entryKey(a) === entryKey(b);
}

function pushLimited(stack, entry) {
  if (!entry) return;
  if (sameContainer(stack[stack.length - 1], entry)) return;
  stack.push(entry);
  if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT);
}

export function createHistoryEntry(state) {
  if (!state || state.mode === 'empty') return null;

  const selected = selectedEntry(state);
  if (state.mode === 'archive' && state.archivePath) {
    return {
      containerKind: 'archive',
      containerPath: state.archivePath,
      selectedPath: selected?.path || '',
      selectedName: selected?.name || '',
    };
  }

  if (state.directory === 'Drives') {
    return {
      containerKind: 'drives',
      containerPath: '__DRIVES__',
      selectedPath: selected?.path || '',
      selectedName: selected?.name || '',
    };
  }

  if (state.directory) {
    return {
      containerKind: 'directory',
      containerPath: state.directory,
      selectedPath: selected?.path || '',
      selectedName: selected?.name || '',
    };
  }

  return null;
}

export function recordNavigation(previousEntry, nextState, options = {}) {
  if (options.history === 'skip') return;

  const nextEntry = createHistoryEntry(nextState);
  if (!previousEntry || !nextEntry || sameContainer(previousEntry, nextEntry)) return;

  pushLimited(backStack, previousEntry);
  forwardStack = [];
  emitChange();
}

export function goBack(currentState) {
  if (backStack.length === 0) return null;
  const currentEntry = createHistoryEntry(currentState);
  const target = backStack.pop();
  if (currentEntry && !sameContainer(currentEntry, target)) {
    pushLimited(forwardStack, currentEntry);
  }
  emitChange();
  return target;
}

export function goForward(currentState) {
  if (forwardStack.length === 0) return null;
  const currentEntry = createHistoryEntry(currentState);
  const target = forwardStack.pop();
  if (currentEntry && !sameContainer(currentEntry, target)) {
    pushLimited(backStack, currentEntry);
  }
  emitChange();
  return target;
}

export function canGoBack() {
  return backStack.length > 0;
}

export function canGoForward() {
  return forwardStack.length > 0;
}
