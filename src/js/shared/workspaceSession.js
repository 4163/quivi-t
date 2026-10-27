import { Core, CORE_SESSION_METHODS } from '../core.js';
import { FsUtils, FS_SESSION_METHODS } from '../fsUtils.js';
import { workspaceSurface } from './workspaceHost.js';
import { WORKSPACE_SURFACES } from '../services/workspaceLayout.js';

const REQUEST_TIMEOUT_MS = 30000;
const MAX_PENDING_REQUESTS = 128;
const ownLabel = workspaceSurface ? `workspace-${WORKSPACE_SURFACES.find(s => s.id === workspaceSurface).window}` : 'main';
const allowedLabels = new Set(['main', 'workspace-file-list', 'workspace-viewport']);
const coreMethods = new Set(CORE_SESSION_METHODS);
const fsMethods = new Set(FS_SESSION_METHODS);
const peers = new Map();
const pending = new Map();
let handlers = {};
let send;
let sequence = 0;
let configBaseline = {};
const sessionId = new URLSearchParams(window.location.search).get('session') || crypto.randomUUID();
let receiveInitial;

export function registerWorkspaceHandlers(next) {
  handlers = next;
}

function rememberConfig(config) {
  configBaseline = Object.fromEntries(Object.entries(config?.frontend_data || {}).map(([key, value]) => [key, JSON.stringify(value)]));
}

function configPatch() {
  const patch = {};
  for (const [key, value] of Object.entries(Core.getState().config.frontend_data)) {
    if (JSON.stringify(value) !== configBaseline[key]) patch[key] = value;
  }
  return patch;
}

export function requestWorkspace(target, group, method, args = []) {
  if (!send) return Promise.reject(new Error('Workspace session is not connected'));
  if (pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('Too many pending workspace requests'));
  const id = `${ownLabel}-${++sequence}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The workspace window did not respond'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });
  const message = { kind: 'request', id, group, method, args };
  if (group === 'config') message.patch = configPatch();
  send(target, message).catch(error => settle(id, undefined, String(error)));
  return promise;
}

function settle(id, value, error) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve(value);
}

async function execute(message) {
  const { group, method, args } = message;
  if (group === 'core' && !workspaceSurface && coreMethods.has(method)) return Core[method](...args);
  if (group === 'fs' && !workspaceSurface && fsMethods.has(method)) return FsUtils[method](...args);
  if (group === 'config' && !workspaceSurface && method === 'persist') {
    await Core.patchFrontendConfig(message.patch, args[0]);
    if ('favorites' in message.patch || 'favorites_collapsed' in message.patch) {
      window.dispatchEvent(new CustomEvent('quivit-favorites-changed'));
    }
    return Core.flushConfig();
  }
  if (Object.hasOwn(handlers, group) && Object.hasOwn(handlers[group], method)) return handlers[group][method](...args);
  throw new Error('Unknown workspace request');
}

function publish(target, full = false, configEvent = false) {
  const previous = peers.get(target) || {};
  const state = Core.getState();
  const configJson = JSON.stringify(state.config);
  const snapshot = { ...state };
  if (!full && state.list === previous.list) delete snapshot.list;
  if (!full && state.src === previous.src) delete snapshot.src;
  if (!full && configJson === previous.configJson) delete snapshot.config;
  peers.set(target, { list: state.list, src: state.src, configJson });
  send(target, { kind: 'snapshot', snapshot, configEvent }).catch(console.error);
}

async function receive(message) {
  if (!message || !allowedLabels.has(message.source) || message.target !== ownLabel || message.source === ownLabel) return;
  if (message.kind === 'ready' && !workspaceSurface && message.source !== 'main') {
    publish(message.source, true, true);
    return;
  }
  if (message.kind === 'snapshot' && workspaceSurface && message.source === 'main') {
    const previousConfig = Core.getState().config;
    if (message.snapshot.config) rememberConfig(message.snapshot.config);
    Core.receiveSnapshot(message.snapshot);
    if (message.snapshot.config && previousConfig?.frontend_data?.favorites !== message.snapshot.config.frontend_data?.favorites) {
      window.dispatchEvent(new CustomEvent('quivit-favorites-changed'));
    }
    if (message.configEvent) window.dispatchEvent(new CustomEvent('quivit-config-loaded'));
    receiveInitial?.();
    return;
  }
  if (message.kind === 'event' && workspaceSurface && message.source === 'main') {
    window.dispatchEvent(new CustomEvent(message.name, { detail: message.detail }));
    return;
  }
  if (message.kind === 'response') {
    settle(message.id, message.value, message.error);
    return;
  }
  if (message.kind !== 'request') return;
  try {
    const value = await execute(message);
    await send(message.source, { kind: 'response', id: message.id, value });
  } catch (error) {
    await send(message.source, { kind: 'response', id: message.id, error: String(error) });
  }
}

export function forgetWorkspacePeer(label) {
  peers.delete(label);
}

export function workspacePopupUrl(surface) {
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ surface, session: sessionId });
  return url.href;
}

export async function initWorkspaceSession() {
  document.documentElement.dataset.workspaceSurface = workspaceSurface || 'main';
  if (window.__TAURI__) {
    const { listen, emitTo } = window.__TAURI__.event;
    send = (target, message) => emitTo(target, 'workspace-message', { ...message, source: ownLabel, target });
    await listen('workspace-message', event => { receive(event.payload).catch(console.error); });
    if (!workspaceSurface) {
      await listen('workspace-detached-closed', event => {
        forgetWorkspacePeer(event.payload);
        window.dispatchEvent(new CustomEvent('quivit-workspace-closed', { detail: event.payload }));
      });
    }
  } else {
    const channel = new BroadcastChannel(`quivit-workspace-${sessionId}`);
    send = async (target, message) => channel.postMessage({ ...message, source: ownLabel, target });
    channel.onmessage = event => { receive(event.data).catch(console.error); };
    window.addEventListener('pagehide', () => channel.close());
  }
  if (workspaceSurface) {
    const forward = (group, method, args) => requestWorkspace('main', group, method, args).catch(error => {
      console.error('[Workspace]', error);
    });
    Core.configureReplica(forward);
    FsUtils.configureReplica(forward);
    const initial = new Promise(resolve => { receiveInitial = resolve; });
    const timeout = setTimeout(() => receiveInitial?.(), REQUEST_TIMEOUT_MS);
    await send('main', { kind: 'ready' });
    await initial;
    clearTimeout(timeout);
    receiveInitial = null;
    return;
  }
  Core.onStateChange(() => { for (const label of peers.keys()) publish(label); });
  window.addEventListener('quivit-config-loaded', () => {
    for (const label of peers.keys()) publish(label, false, true);
  });
  for (const name of ['quivit-favorites-changed', 'quivit-library-updated', 'quivit-download-complete',
    'quivit-download-status', 'quivit-refresh-start', 'quivit-refresh-end', 'quivit-workspace-import-activity', 'quivit-workspace-strip-info']) {
    window.addEventListener(name, event => {
      for (const label of peers.keys()) send(label, { kind: 'event', name, detail: event.detail }).catch(console.error);
    });
  }
  window.addEventListener('pagehide', () => {
    for (const popup of windowPopups.values()) popup.close();
  });
}

export const windowPopups = new Map();
