const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);

const initialState = {};

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
}
