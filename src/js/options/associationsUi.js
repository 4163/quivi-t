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
    
    const grouped = {};
    for (const f of formats) {
      if (!grouped[f.category]) grouped[f.category] = [];
      grouped[f.category].push(f);
    }

    container.innerHTML = '';
    
    for (const [category, items] of Object.entries(grouped)) {
      const header = document.createElement('h4');
      header.textContent = `${category}s`;
      header.className = 'assoc-header';
      container.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'assoc-grid';
      
      for (const item of items) {
        const label = document.createElement('label');
        label.className = 'checkbox-label assoc-label';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'assoc-checkbox';
        checkbox.dataset.ext = item.ext;
        checkbox.checked = item.registered;
        initialState[item.ext] = item.registered;
        checkbox.title = 'Registers or unregisters QuiviT for this file type. Windows Settings controls the active default app.';
        
        const img = document.createElement('img');
        const pngIcon = item.icon.replace('.ico', '.png');
        img.src = '/assets/icons/' + pngIcon;
        img.alt = item.ext;
        img.className = 'assoc-icon';
        
        const text = document.createElement('span');
        text.textContent = '.' + item.ext + ' (' + item.name + ')';
        text.className = 'assoc-text';
        text.title = item.registered
          ? 'QuiviT is registered for this format.'
          : 'QuiviT is not registered for this format.';
        
        label.appendChild(checkbox);
        label.appendChild(img);
        label.appendChild(text);
        
        grid.appendChild(label);
      }
      container.appendChild(grid);
    }
  } catch (err) {
    container.innerHTML = '<p style="color:var(--error)">Error loading formats: ' + err + '</p>';
  }

  const selectAll = document.getElementById('btn-assoc-select-all');
  if (selectAll) selectAll.onclick = () => document.querySelectorAll('.assoc-checkbox').forEach(cb => cb.checked = true);

  const deselectAll = document.getElementById('btn-assoc-deselect-all');
  if (deselectAll) deselectAll.onclick = () => document.querySelectorAll('.assoc-checkbox').forEach(cb => cb.checked = false);

  // Hide the redundant apply button since we hook into the shared Options Apply.
  const applyBtn = document.getElementById('btn-assoc-apply');
  if (applyBtn) {
    applyBtn.style.display = 'none';
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
          statusCallback('Failed to open Windows Settings.');
        }
      }
    };
  }
}
