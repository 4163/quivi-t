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

export async function applyAssociations(statusCallback) {
  if (!invoke) return;
  const toRegister = [];
  const toUnregister = [];
  document.querySelectorAll('.assoc-checkbox').forEach(cb => {
    const ext = cb.dataset.ext;
    if (cb.checked !== initialState[ext]) {
      if (cb.checked) {
        toRegister.push(ext);
      } else {
        toUnregister.push(ext);
      }
      initialState[ext] = cb.checked; // Update baseline
    }
  });
  
  if (toRegister.length === 0 && toUnregister.length === 0) return;

  try {
    if (statusCallback) statusCallback('Applying associations...');
    if (toUnregister.length > 0) {
      await invoke('unregister_associations', { extensions: toUnregister });
    }
    if (toRegister.length > 0) {
      await invoke('register_associations', { extensions: toRegister });
    }
    if (statusCallback) statusCallback('Associations updated successfully.');
  } catch (err) {
    console.error('[Assoc] Apply error:', err);
    if (statusCallback) statusCallback('Failed to apply associations: ' + err);
  }
}

export async function initAssociationsUi(containerId, statusCallback) {
  const container = document.getElementById(containerId);
  if (!container || !invoke) return;

  try {
    const formats = await invoke('get_format_status');
    const registeredSet = new Set(formats.filter(f => f.registered).map(f => f.ext));
    
    document.querySelectorAll('.assoc-checkbox').forEach(checkbox => {
      const ext = checkbox.dataset.ext;
      const isRegistered = registeredSet.has(ext);
      checkbox.checked = isRegistered;
      initialState[ext] = isRegistered;
      
      const textSpan = checkbox.closest('label').querySelector('.assoc-text');
      if (textSpan) {
        textSpan.title = isRegistered 
          ? 'QuiviT is registered for this format.' 
          : 'QuiviT is not registered for this format.';
      }
    });
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
          statusCallback('Failed to open Windows Settings.');
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
