export function parseLocalPath(input) {
  if (typeof input !== 'string') return null;
  const str = input.trim().replace(/^["']|["']$/g, '');
  if (!str) return null;
  if (/^[a-zA-Z]:[\\/]/.test(str) || str.startsWith('\\\\')) return str;
  if (/^file:\/\//i.test(str)) {
    try {
      const u = new URL(str);
      let decoded = decodeURIComponent(u.pathname);
      if (u.hostname && u.hostname !== 'localhost') {
        return '\\\\' + u.hostname + decoded.replace(/\//g, '\\');
      }
      if (/^\/[a-zA-Z]:/.test(decoded)) decoded = decoded.slice(1);
      return decoded.replace(/\//g, '\\');
    } catch {
      return null;
    }
  }
  if (/^file:/i.test(str)) {
    const raw = str.slice(5).replace(/^\/+/, '');
    try {
      let decoded = decodeURIComponent(raw);
      if (/^[a-zA-Z]:/.test(decoded)) return decoded.replace(/\//g, '\\');
    } catch {
      return null;
    }
  }
  return null;
}

export function createImportActions({ invoke, FsUtils, loadUrl, cancelUrlImport, sanitizeSvg, activateMisc, libraryUpdated }) {
  let active = null;
  const listeners = new Set();

  function notify(phase) {
    const state = { importing: Boolean(active), phase, dropId: active?.dropId || null };
    for (const listener of listeners) listener(state);
  }

  function begin(dropId = null) {
    if (active) throw new Error('Another import is already in progress');
    active = { dropId, generation: FsUtils.beginNavigationIntent(), completing: false };
    notify(dropId ? 'receiving' : 'resolving');
    return active;
  }

  function finish(request) {
    if (active !== request) return;
    active = null;
    notify('idle');
  }

  async function release(dropId) {
    if (dropId) await invoke('release_drop', { dropId }).catch(() => {});
  }

  async function openResult(request, path, options = {}) {
    if (!FsUtils.isNavigationIntentCurrent(request.generation)) return;
    notify('opening');
    await FsUtils.loadFile(path, { ...options, generation: request.generation, restoreLastImage: false });
  }

  async function openUrlResult(request, url) {
    const { galleryPath, targetName } = await loadUrl(url);
    if (!FsUtils.isNavigationIntentCurrent(request.generation)) {
      cancelUrlImport(galleryPath);
      return;
    }
    await openResult(request, galleryPath, targetName ? { targetName } : {});
  }

  async function openPathResult(request, path) {
    const kind = await invoke('get_path_kind', { path });
    if (kind === 'missing') throw new Error('Path not found');
    await openResult(request, path, { preferInitial: true });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener({ importing: Boolean(active), phase: active ? 'receiving' : 'idle', dropId: active?.dropId || null });
      return () => listeners.delete(listener);
    },
    async openUrl(url) {
      const local = parseLocalPath(url);
      if (local) return this.openPath(local);
      const request = begin();
      try { await openUrlResult(request, url); } finally { finish(request); }
    },
    async openPath(path) {
      const normalized = parseLocalPath(path) || path;
      const request = begin();
      try { await openPathResult(request, normalized); } finally { finish(request); }
    },
    acceptDrop(dropId) {
      try { begin(dropId); return true; } catch (err) { release(dropId); throw err; }
    },
    failDrop(dropId) {
      if (active?.dropId !== dropId) return false;
      const request = active;
      release(dropId);
      finish(request);
      return true;
    },
    async completeDrop(dropId) {
      if (!dropId || active?.dropId !== dropId) { await release(dropId); return; }
      const request = active;
      if (request.completing) return;
      request.completing = true;
      try {
        notify('preparing');
        const payload = await invoke('describe_drop', { dropId });
        if (!FsUtils.isNavigationIntentCurrent(request.generation)) return;
        if (payload.kind === 'path') {
          await openPathResult(request, payload.path);
        } else if (payload.kind === 'url') {
          const local = parseLocalPath(payload.url);
          if (local) {
            await openPathResult(request, local);
          } else {
            const parsed = new URL(payload.url);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS links can be imported');
            await openUrlResult(request, parsed.href);
          }
        } else if (payload.kind === 'capture') {
          const sanitizedSvg = payload.svgText === null ? undefined : sanitizeSvg(payload.svgText);
          const path = await invoke('save_dropped_image', { dropId, sanitizedSvg });
          libraryUpdated();
          if (FsUtils.isNavigationIntentCurrent(request.generation)) activateMisc();
          await openResult(request, path, { preferInitial: true });
        } else {
          throw new Error('Drop content is not supported');
        }
      } finally {
        await release(dropId);
        finish(request);
      }
    }
  };
}
