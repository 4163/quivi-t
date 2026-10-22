const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);

const initialState = {};

const RECOMMENDED_EXTENSIONS = new Set([
  'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif', 'cbz', 'cbr', 'cb7', 'cbt'
]);

// Mascot group mapping: extension → mascot data-group
const EXT_TO_GROUP = new Map([
  ['jpg', 'mascot'], ['jpeg', 'mascot'], ['png', 'mascot'], ['bmp', 'mascot'], ['ico', 'mascot'],
  ['gif', 'moe1'], ['webp', 'moe1'], ['apng', 'moe1'], ['svg', 'moe1'], ['avif', 'moe1'],
  ['cbz', 'moe3'], ['cbr', 'moe3'], ['cb7', 'moe3'], ['cbt', 'moe3'],
  ['zip', 'stoic'], ['rar', 'stoic'], ['7z', 'stoic'], ['tar', 'stoic']
]);

function setCheckboxRegistered(checkbox, registered, { preserveSelection = false } = {}) {
  if (!preserveSelection) checkbox.checked = registered;
  initialState[checkbox.dataset.ext] = registered;
  const textSpan = checkbox.closest('label')?.querySelector('.assoc-text');
  if (textSpan) {
    textSpan.title = registered
      ? 'QuiviT is registered for this format.'
      : 'QuiviT is not registered for this format.';
  }
}

async function refreshAssociations(options) {
  const formats = await invoke('get_format_status');
  const registeredSet = new Set(formats.filter(format => format.registered).map(format => format.ext));
  document.querySelectorAll('.assoc-checkbox').forEach(checkbox => {
    setCheckboxRegistered(checkbox, registeredSet.has(checkbox.dataset.ext), options);
  });
  return registeredSet;
}

export async function applyAssociations(statusCallback) {
  if (!invoke) return { ok: false, message: 'File Types is unavailable.' };
  const toRegister = [];
  const toUnregister = [];
  const changes = [];
  document.querySelectorAll('.assoc-checkbox').forEach(cb => {
    const ext = cb.dataset.ext;
    if (cb.checked !== initialState[ext]) {
      changes.push({ ext, registered: cb.checked });
      if (cb.checked) {
        toRegister.push(ext);
        if (ext === 'bmp') toRegister.push('dib');
      } else {
        toUnregister.push(ext);
        if (ext === 'bmp') toUnregister.push('dib');
      }
    }
  });
  
  if (toRegister.length === 0 && toUnregister.length === 0) return { ok: true };

  try {
    if (statusCallback) statusCallback('Updating file types...');
    await invoke('apply_associations', { toRegister, toUnregister });
    changes.forEach(({ ext, registered }) => { initialState[ext] = registered; });
    if (statusCallback) statusCallback('File types updated.');
    return { ok: true };
  } catch (err) {
    console.error('[Assoc] Apply error:', err);
    try {
      await refreshAssociations({ preserveSelection: true });
    } catch (refreshErr) {
      changes.forEach(({ ext }) => { delete initialState[ext]; });
      console.warn('[Assoc] Could not refresh formats after apply error:', refreshErr);
    }
    const detail = typeof err === 'string' ? err.trim() : String(err?.message || '').trim();
    let message = 'File types could not be updated.';
    if (detail.startsWith('The release build')) {
      message = 'Release build not found. Start it once, then retry File Types.';
    } else if (
      (detail.startsWith('Close the preview pane and Explorer windows, then retry:')
        && /\(os error (?:5|32|33)\)/.test(detail))
      || detail.startsWith('Preview helper update is pending.')
    ) {
      message = 'File types could not be updated. Previews may still be in use. Close all File Explorer windows, restart QuiviT, then save again.';
    } else if (detail) {
      message += ` ${detail}`;
    }
    statusCallback?.(message);
    return { ok: false, message };
  }
}

export async function initAssociationsUi(containerId, statusCallback) {
  const container = document.getElementById(containerId);
  if (!container || !invoke) return;

  try {
    const registeredSet = await refreshAssociations();
    if (registeredSet.size > 0) {
      try {
        // Migrate previews for associations created before Explorer preview support.
        await invoke('sync_preview_associations');
      } catch (syncErr) {
        console.warn('[Assoc] Preview migration skipped:', syncErr);
      }
    }
  } catch (err) {
    console.error('[Assoc] Error loading formats:', err);
    container.classList.add('is-error');
  }

  const recommended = document.getElementById('btn-assoc-recommended');
  if (recommended) {
    recommended.onclick = () => {
      document.querySelectorAll('.assoc-checkbox').forEach(cb => {
        cb.checked = RECOMMENDED_EXTENSIONS.has(cb.dataset.ext?.toLowerCase());
      });
    };
  }

  const selectAll = document.getElementById('btn-assoc-select-all');
  if (selectAll) selectAll.onclick = () => document.querySelectorAll('.assoc-checkbox').forEach(cb => cb.checked = true);

  const deselectAll = document.getElementById('btn-assoc-deselect-all');
  if (deselectAll) deselectAll.onclick = () => document.querySelectorAll('.assoc-checkbox').forEach(cb => cb.checked = false);

  const removeButton = document.getElementById('btn-assoc-remove');
  const removeDialog = document.getElementById('assoc-remove-dialog');
  if (removeButton && removeDialog) {
    removeButton.onclick = () => {
      removeDialog.returnValue = '';
      removeDialog.showModal();
    };
    removeDialog.addEventListener('close', async () => {
      if (removeDialog.returnValue !== 'remove') return;
      const saveButton = document.getElementById('btn-save-options');
      removeButton.disabled = true;
      if (saveButton) saveButton.disabled = true;
      try {
        statusCallback?.('Removing QuiviT file registrations...');
        const formats = await invoke('get_format_status');
        await invoke('unregister_associations', { extensions: formats.map(format => format.ext) });
        document.querySelectorAll('.assoc-checkbox').forEach(checkbox => {
          setCheckboxRegistered(checkbox, false);
        });
        statusCallback?.('QuiviT file registrations removed.');
      } catch (err) {
        console.error('[Assoc] Removal error:', err);
        try {
          await refreshAssociations();
        } catch (refreshErr) {
          console.error('[Assoc] Could not refresh formats after removal error:', refreshErr);
        }
        statusCallback?.('Could not remove QuiviT file registrations.');
      } finally {
        removeButton.disabled = false;
        if (saveButton) saveButton.disabled = false;
      }
    });
  }

  const settingsBtn = document.getElementById('btn-assoc-settings');
  if (settingsBtn) {
    settingsBtn.onclick = async () => {
      try {
        // Try deep-link to QuiviT's section (Win11 23H2+), falls back to generic page
        await invoke('open_in_explorer', { path: "ms-settings:defaultapps?registeredAppUser=QuiviT" });
      } catch (err) {
        try {
          await invoke('open_in_explorer', { path: "ms-settings:defaultapps" });
        } catch (err2) {
          statusCallback('Could not open Windows Settings.');
        }
      }
    };
  }

  const mascotsBar = document.getElementById('assoc-mascots');
  const mascotBoxes = new Map();
  if (mascotsBar) {
    mascotsBar.querySelectorAll('.assoc-mascot-box').forEach(box => {
      const group = box.dataset.group;
      const icon = box.querySelector('.assoc-format-icon');
      if (group && icon) {
        mascotBoxes.set(group, { box, icon });
      }
    });
  }

  let currentExt = null;

  const setHoveredFormat = (ext) => {
    if (currentExt === ext) return;
    currentExt = ext;
    const targetGroup = EXT_TO_GROUP.get(ext);

    mascotBoxes.forEach(({ box, icon }, group) => {
      if (group === targetGroup) {
        icon.src = `/assets/icons/${ext}.png`;
        box.classList.add('is-active');
      } else {
        box.classList.remove('is-active');
      }
    });
  };

  const clearHoveredFormat = () => {
    if (currentExt === null) return;
    currentExt = null;
    mascotBoxes.forEach(({ box }) => box.classList.remove('is-active'));
  };

  container.addEventListener('pointerover', (e) => {
    const label = e.target.closest('.assoc-label');
    if (!label) return;
    const ext = label.querySelector('.assoc-checkbox')?.dataset.ext?.toLowerCase();
    if (ext && EXT_TO_GROUP.has(ext)) {
      setHoveredFormat(ext);
    }
  });

  container.addEventListener('pointerout', (e) => {
    const label = e.target.closest('.assoc-label');
    if (!label) return;
    const nextLabel = e.relatedTarget ? e.relatedTarget.closest('.assoc-label') : null;
    if (!nextLabel) {
      clearHoveredFormat();
    }
  });

  container.addEventListener('pointerleave', clearHoveredFormat);
}
