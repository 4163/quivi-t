/**
 * menubar.js
 * Handles the top menubar and dropdown menus.
 */

let activeMenu = null;

import { FILTERS, SCALERS, activeFilterId } from './services/registry.js';
import { getEffectiveScaling } from './services/viewerMath.js';
import {
  getFavoritesState,
  setActiveLoadout,
  createLoadout,
  renameLoadout,
  deleteLoadout
} from './filepanel/favoritesStore.js';
import {
  fetchLibraryTree,
  hasLibraryEntries,
  hasProviderNodes,
  orderProviders,
  getProviderOrder,
  setActiveProvider,
  resolveActiveProvider,
  MISC_PROVIDER
} from './filepanel/libraryStore.js';
import { fetchManifest } from './urlLoader.js';
import { FsUtils } from './fsUtils.js';

export function initMenuBar() {
  bindMenus();
  bindFavoritesDropdown();
  renderFavoritesMenu();
  bindImportsDropdown();
  renderImportsMenu();
}

const AIM_DELAY = 120;

const aimState = {
  timer: null,
  pendingItem: null,
  activeSubmenuItem: null,
  activeSubmenu: null,
  activeDropdown: null,
  mouseLoc: { x: 0, y: 0 },
  prevMouseLoc: { x: 0, y: 0 },
  exitLoc: { x: 0, y: 0 }
};

function isPointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function isInSafeTriangle(px, py, prevX, prevY, triggerItem, submenu) {
  if (!triggerItem || !submenu) return false;
  const subRect = submenu.getBoundingClientRect();
  const triggerRect = triggerItem.getBoundingClientRect();
  const BUFFER = 16;

  // Inside submenu bounding box (with buffer): safe.
  if (px >= subRect.left - 4 && px <= subRect.right + 4 &&
      py >= subRect.top - BUFFER && py <= subRect.bottom + BUFFER) {
    return true;
  }

  const dx = (prevX !== null && prevX !== undefined && prevX !== 0) ? px - prevX : 0;
  const dy = (prevY !== null && prevY !== undefined && prevY !== 0) ? py - prevY : 0;
  const isRight = subRect.left >= triggerRect.left;

  if (isRight) {
    // 1. Must be moving horizontally towards the submenu (rightward).
    if (dx <= 0) return false;

    // 2. Predominantly vertical movements (browsing list items up/down) bypass safe cone.
    if (Math.abs(dy) > dx * 1.6) return false;

    if (px < triggerRect.left) return false;

    const ax = aimState.exitLoc.x
      ? Math.max(triggerRect.left + triggerRect.width * 0.4, Math.min(aimState.exitLoc.x, triggerRect.right))
      : (triggerRect.left + triggerRect.width * 0.5);
    const ay = aimState.exitLoc.y || (triggerRect.top + triggerRect.height * 0.5);
    const bx = subRect.left;
    const by = subRect.top - BUFFER;
    const cx = subRect.left;
    const cy = subRect.bottom + BUFFER;
    return isPointInTriangle(px, py, ax, ay, bx, by, cx, cy);
  } else {
    if (dx >= 0) return false;
    if (Math.abs(dy) > Math.abs(dx) * 1.6) return false;
    if (px > triggerRect.right) return false;

    const ax = aimState.exitLoc.x
      ? Math.min(triggerRect.right - triggerRect.width * 0.4, Math.max(aimState.exitLoc.x, triggerRect.left))
      : (triggerRect.left + triggerRect.width * 0.5);
    const ay = aimState.exitLoc.y || (triggerRect.top + triggerRect.height * 0.5);
    const bx = subRect.right;
    const by = subRect.top - BUFFER;
    const cx = subRect.right;
    const cy = subRect.bottom + BUFFER;
    return isPointInTriangle(px, py, ax, ay, bx, by, cx, cy);
  }
}

function activateItem(item, dropdown) {
  if (aimState.timer) {
    clearTimeout(aimState.timer);
    aimState.timer = null;
  }
  aimState.pendingItem = null;
  aimState.exitLoc.x = 0;
  aimState.exitLoc.y = 0;
  if (dropdown) dropdown.classList.remove('submenu-aiming');

  if (dropdown) {
    dropdown.querySelectorAll(':scope > .has-submenu.open').forEach(sub => {
      if (sub !== item) {
        sub.classList.remove('open');
        sub.setAttribute('aria-expanded', 'false');
        const flyout = sub.querySelector(':scope > .submenu');
        if (flyout) {
          flyout.style.removeProperty('--submenu-top');
          flyout.style.removeProperty('--submenu-left');
          flyout.style.removeProperty('--submenu-max-height');
        }
      }
    });
  }

  if (item && item.classList.contains('has-submenu')) {
    item.classList.add('open');
    item.setAttribute('aria-expanded', 'true');
    aimState.activeSubmenuItem = item;
    aimState.activeSubmenu = item.querySelector(':scope > .submenu');
    aimState.activeDropdown = dropdown;

    if (aimState.activeSubmenu) {
      const rect = item.getBoundingClientRect();
      const topPos = Math.max(4, rect.top - 4);
      aimState.activeSubmenu.style.setProperty('--submenu-top', `${topPos}px`);
      aimState.activeSubmenu.style.setProperty('--submenu-left', `${rect.right}px`);
      aimState.activeSubmenu.dataset.side = 'right';
      const maxH = window.innerHeight - topPos - 8;
      aimState.activeSubmenu.style.setProperty('--submenu-max-height', `${Math.max(120, maxH)}px`);
      const subW = aimState.activeSubmenu.offsetWidth || 180;
      if (rect.right + subW > window.innerWidth) {
        aimState.activeSubmenu.style.setProperty('--submenu-left', `${Math.max(0, rect.left - subW)}px`);
        aimState.activeSubmenu.dataset.side = 'left';
      }
    }
  } else {
    aimState.activeSubmenuItem = null;
    aimState.activeSubmenu = null;
    aimState.activeDropdown = null;
  }
}

export function closeMenus() {
  if (aimState.timer) {
    clearTimeout(aimState.timer);
    aimState.timer = null;
  }
  aimState.pendingItem = null;
  aimState.activeSubmenuItem = null;
  aimState.activeSubmenu = null;
  aimState.activeDropdown = null;
  aimState.exitLoc.x = 0;
  aimState.exitLoc.y = 0;
  document.querySelectorAll('.menu-dropdown.submenu-aiming').forEach(el => el.classList.remove('submenu-aiming'));

  if (!activeMenu) return;
  activeMenu.classList.remove('open');
  activeMenu.querySelectorAll('.has-submenu.open').forEach(s => {
    s.classList.remove('open');
    s.setAttribute('aria-expanded', 'false');
    const flyout = s.querySelector(':scope > .submenu');
    if (flyout) {
      flyout.style.removeProperty('--submenu-top');
      flyout.style.removeProperty('--submenu-left');
      flyout.style.removeProperty('--submenu-max-height');
    }
  });
  activeMenu = null;
}


function bindMenus() {
  document.querySelectorAll('.menu-item').forEach(menu => {
    const trigger = menu.querySelector('.menu-trigger');

    trigger.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (activeMenu === menu) {
        closeMenus();
      } else {
        closeMenus();
        if (menu.id === 'menu-favorites') renderFavoritesMenu();
        if (menu.id === 'menu-imports') renderImportsMenu();
        menu.classList.add('open');
        activeMenu = menu;
      }
    });

    trigger.addEventListener('mouseenter', () => {
      if (!activeMenu || activeMenu === menu) return;
      closeMenus();
      if (menu.id === 'menu-favorites') renderFavoritesMenu();
      if (menu.id === 'menu-imports') renderImportsMenu();
      menu.classList.add('open');
      activeMenu = menu;
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
        if (menu.id === 'menu-favorites') renderFavoritesMenu();
        if (menu.id === 'menu-imports') renderImportsMenu();
        menu.classList.add('open');
        activeMenu = menu;
        // Focus the first dropdown item.
        const firstItem = menu.querySelector('.menu-dropdown > li[role="menuitem"]');
        if (firstItem) firstItem.focus();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
      }
      
      // Arrow navigation between top menubar triggers.
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const triggers = Array.from(document.querySelectorAll('#menubar .menu-trigger'))
          .filter((t) => !t.closest('.menu-item')?.hidden);
        const idx = triggers.indexOf(trigger);
        if (idx !== -1) {
          let nextIdx = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
          if (nextIdx < 0) nextIdx = triggers.length - 1;
          if (nextIdx >= triggers.length) nextIdx = 0;
          triggers[nextIdx].focus();
          if (activeMenu) {
            closeMenus();
            const nextMenu = triggers[nextIdx].closest('.menu-item');
            nextMenu.classList.add('open');
            activeMenu = nextMenu;
          }
        }
      }
    });
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu-item')) closeMenus();
  });
  window.addEventListener('resize', closeMenus);

  // Keyboard and click support for dropdown lists and submenus.
  // The Imports dropdown owns its rows (dynamic providers plus static All),
  // so generic per-item binding skips it to keep one owner per surface.
  document.querySelectorAll('.menu-dropdown').forEach(dropdown => {
    if (dropdown.id === 'imports-menu-dropdown') return;
    dropdown.addEventListener('mousemove', (e) => {
      const prevX = aimState.mouseLoc.x;
      const prevY = aimState.mouseLoc.y;
      aimState.prevMouseLoc.x = prevX;
      aimState.prevMouseLoc.y = prevY;
      aimState.mouseLoc.x = e.clientX;
      aimState.mouseLoc.y = e.clientY;

      if (aimState.pendingItem && aimState.activeSubmenuItem && aimState.activeDropdown === dropdown) {
        if (!isInSafeTriangle(e.clientX, e.clientY, prevX, prevY, aimState.activeSubmenuItem, aimState.activeSubmenu)) {
          activateItem(aimState.pendingItem, dropdown);
        }
      }
    });

    dropdown.addEventListener('mouseleave', () => {
      if (aimState.timer) {
        clearTimeout(aimState.timer);
        aimState.timer = null;
      }
      aimState.pendingItem = null;
      dropdown.classList.remove('submenu-aiming');
    });

    dropdown.addEventListener('scroll', () => {
      if (aimState.activeSubmenuItem && aimState.activeDropdown === dropdown) {
        activateItem(null, dropdown);
      }
    });

    const items = Array.from(dropdown.children).filter(el => el.matches('li[role="menuitem"]'));
    items.forEach((item, index) => {
      const isSubmenuTrigger = item.classList.contains('has-submenu');
      const submenuEl = isSubmenuTrigger ? item.querySelector(':scope > .submenu') : null;

      if (isSubmenuTrigger) {
        item.addEventListener('mouseleave', (e) => {
          aimState.exitLoc.x = e.clientX;
          aimState.exitLoc.y = e.clientY;
        });
      }

      if (submenuEl) {
        submenuEl.addEventListener('mouseenter', () => {
          if (aimState.timer) {
            clearTimeout(aimState.timer);
            aimState.timer = null;
          }
          aimState.pendingItem = null;
          dropdown.classList.remove('submenu-aiming');
        });
      }

      item.addEventListener('mouseenter', (e) => {
        const parentSub = item.closest('.submenu');
        if (parentSub) {
          const parentDrop = parentSub.closest('.menu-dropdown');
          parentDrop?.classList.remove('submenu-aiming');
        }

        if (aimState.activeSubmenuItem === item) {
          if (aimState.timer) {
            clearTimeout(aimState.timer);
            aimState.timer = null;
          }
          aimState.pendingItem = null;
          dropdown.classList.remove('submenu-aiming');
          return;
        }

        if (aimState.activeSubmenuItem && aimState.activeDropdown === dropdown) {
          if (isInSafeTriangle(e.clientX, e.clientY, aimState.prevMouseLoc.x, aimState.prevMouseLoc.y, aimState.activeSubmenuItem, aimState.activeSubmenu)) {
            aimState.pendingItem = item;
            dropdown.classList.add('submenu-aiming');
            if (aimState.timer) clearTimeout(aimState.timer);
            aimState.timer = setTimeout(() => {
              activateItem(aimState.pendingItem, dropdown);
            }, AIM_DELAY);
            return;
          }
        }

        activateItem(item, dropdown);
      });

      item.addEventListener('keydown', (e) => {
        const parentSubmenu = item.closest('.submenu');

        if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          e.stopPropagation();
          if (isSubmenuTrigger) {
            activateItem(item, dropdown);
            item.querySelector('.submenu > li[role="menuitem"]')?.focus();
          } else {
            item.click();
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (parentSubmenu) {
            const parentLi = item.closest('.has-submenu');
            if (parentLi) {
              const parentDrop = parentLi.closest('.menu-dropdown');
              if (parentDrop) activateItem(null, parentDrop);
              parentLi.focus();
            }
          } else {
            closeMenus();
            const trigger = item.closest('.menu-item')?.querySelector('.menu-trigger');
            if (trigger) trigger.focus();
          }
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          const next = items[index + 1] || items[0];
          next.focus();
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          const prev = items[index - 1] || items[items.length - 1];
          prev.focus();
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          if (isSubmenuTrigger) {
            activateItem(item, dropdown);
            item.querySelector('.submenu > li[role="menuitem"]')?.focus();
          } else if (!parentSubmenu) {
            // Pass control back to the top-level menubar triggers.
            const trigger = item.closest('.menu-item')?.querySelector('.menu-trigger');
            if (trigger) {
              const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
              trigger.dispatchEvent(event);
            }
          }
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          if (parentSubmenu) {
            const parentLi = item.closest('.has-submenu');
            if (parentLi) {
              const parentDrop = parentLi.closest('.menu-dropdown');
              if (parentDrop) activateItem(null, parentDrop);
              parentLi.focus();
            }
          } else {
            // Pass control back to the top-level menubar triggers.
            const trigger = item.closest('.menu-item')?.querySelector('.menu-trigger');
            if (trigger) {
              const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
              trigger.dispatchEvent(event);
            }
          }
        }
      });

      item.addEventListener('click', (e) => {
        if (item.classList.contains('has-submenu')) {
          e.stopPropagation();
          if (item.classList.contains('open')) {
            activateItem(null, dropdown);
          } else {
            activateItem(item, dropdown);
          }
          return;
        }
        if (e.target.tagName === 'INPUT' || e.target.closest('input') || e.target.closest('button')) {
          return;
        }
        if (item.classList.contains('muted') || item.getAttribute('aria-disabled') === 'true') {
          e.stopPropagation();
          return;
        }
        closeMenus();
      });
    });
  });
}

function submitNewLoadout(newInput) {
  if (!newInput) return;
  const val = newInput.value.trim();
  const created = createLoadout(val);
  if (created?.name) {
    setActiveLoadout(created.name);
  }
  newInput.value = '';
  renderFavoritesMenu();
  newInput.focus();
}

export function renderFavoritesMenu() {
  const dropdown = document.getElementById('favorites-menu-dropdown');
  const rowTemplate = document.getElementById('loadout-row-template');
  if (!dropdown || !rowTemplate) return;

  const state = getFavoritesState();
  const isSingle = state.loadouts.length <= 1;
  const separator = dropdown.querySelector(':scope > .separator');
  const anchor = separator || dropdown.querySelector(':scope > .loadout-new-container');
  const rows = Array.from(dropdown.children).filter(el => el.classList?.contains('loadout-item'));

  state.loadouts.forEach((loadout, i) => {
    let li = rows[i];
    if (!li) {
      li = rowTemplate.content.firstElementChild.cloneNode(true);
      dropdown.insertBefore(li, anchor);
    }
    li.dataset.loadoutName = loadout.name;
    li.classList.toggle('checked', loadout.name === state.active);
    li.classList.toggle('single', isSingle);
    const input = li.querySelector('.loadout-name-input');
    if (input && document.activeElement !== input) {
      input.value = loadout.name;
      input.size = Math.max(1, loadout.name.length);
    }
    const delBtn = li.querySelector('.loadout-remove-btn');
    if (delBtn) delBtn.hidden = isSingle;
  });

  for (let i = rows.length - 1; i >= state.loadouts.length; i--) {
    rows[i].remove();
  }
}

function bindFavoritesDropdown() {
  const dropdown = document.getElementById('favorites-menu-dropdown');
  if (!dropdown) return;

  dropdown.addEventListener('mousedown', (e) => {
    if (e.target.matches('input, button') || e.target.closest('input, button')) {
      e.stopPropagation();
    }
  });

  dropdown.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.loadout-remove-btn');
    if (removeBtn) {
      e.stopPropagation();
      e.preventDefault();
      const row = removeBtn.closest('.loadout-item');
      if (row?.dataset?.loadoutName) {
        deleteLoadout(row.dataset.loadoutName);
        renderFavoritesMenu();
      }
      return;
    }

    const addBtn = e.target.closest('.loadout-add-btn');
    if (addBtn) {
      e.stopPropagation();
      e.preventDefault();
      const container = addBtn.closest('.loadout-new-container');
      submitNewLoadout(container?.querySelector('.loadout-new-input'));
      return;
    }

    if (e.target.matches('input') || e.target.closest('input')) {
      return;
    }

    const row = e.target.closest('.loadout-item');
    if (row?.dataset?.loadoutName) {
      e.stopPropagation();
      setActiveLoadout(row.dataset.loadoutName);
      renderFavoritesMenu();
    }
  });

  dropdown.addEventListener('input', (e) => {
    const nameInput = e.target.closest('.loadout-name-input');
    if (nameInput) {
      nameInput.size = Math.max(1, nameInput.value.length);
    }
  });

  dropdown.addEventListener('keydown', (e) => {
    const nameInput = e.target.closest('.loadout-name-input');
    if (nameInput) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        nameInput.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const row = nameInput.closest('.loadout-item');
        if (row?.dataset?.loadoutName) nameInput.value = row.dataset.loadoutName;
        nameInput.blur();
      }
      return;
    }

    const newInput = e.target.closest('.loadout-new-input');
    if (newInput) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitNewLoadout(newInput);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMenus();
      }
      return;
    }

    if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Enter' || e.key === ' ')) {
      const row = e.target.closest('.loadout-item');
      if (row?.dataset?.loadoutName) {
        e.preventDefault();
        e.stopPropagation();
        const targetName = row.dataset.loadoutName;
        setActiveLoadout(targetName);
        renderFavoritesMenu();
        const activeItem = dropdown.querySelector(`li[data-loadout-name="${CSS.escape(targetName)}"]`);
        if (activeItem) activeItem.focus();
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const row = e.target.closest('li[role="menuitem"]');
      if (row) {
        const items = Array.from(dropdown.querySelectorAll('li[role="menuitem"]'));
        const idx = items.indexOf(row);
        if (idx !== -1) {
          e.preventDefault();
          e.stopPropagation();
          const nextIdx = e.key === 'ArrowDown'
            ? (idx + 1) % items.length
            : (idx - 1 + items.length) % items.length;
          items[nextIdx].focus();
        }
      }
    }
  });

  dropdown.addEventListener('focusout', (e) => {
    const nameInput = e.target.closest('.loadout-name-input');
    if (!nameInput) return;
    const row = nameInput.closest('.loadout-item');
    if (!row?.dataset?.loadoutName) return;
    const oldName = row.dataset.loadoutName;
    const newName = nameInput.value.trim();
    if (newName !== oldName) {
      const ok = renameLoadout(oldName, newName);
      if (ok) {
        renderFavoritesMenu();
      } else {
        nameInput.value = oldName;
        nameInput.size = Math.max(1, oldName.length);
      }
    } else {
      nameInput.value = oldName;
      nameInput.size = Math.max(1, oldName.length);
    }
  });

  window.addEventListener('quivit-favorites-changed', renderFavoritesMenu);
  window.addEventListener('quivit-config-loaded', renderFavoritesMenu);
}

export async function renderImportsMenu() {
  const dropdown = document.getElementById('imports-menu-dropdown');
  const rowTemplate = document.getElementById('import-provider-row-template');
  const menuItem = document.getElementById('menu-imports');
  if (!dropdown || !rowTemplate) return;

  let treeRaw = [];
  let manifest = null;
  try {
    [treeRaw, manifest] = await Promise.all([
      fetchLibraryTree().catch(() => []),
      fetchManifest().catch(() => null)
    ]);
  } catch {
    treeRaw = [];
  }
  if (FsUtils?.hasPendingDeletions && FsUtils.hasPendingDeletions()) {
    for (const provider of treeRaw) {
      if (!provider?.nodes) continue;
      provider.nodes = provider.nodes.filter(n => !FsUtils.isPendingDeletion(n.path));
    }
  }
  const prevOrder = getProviderOrder();
  const tree = orderProviders(Array.isArray(treeRaw) ? treeRaw : []);
  const hasAny = hasLibraryEntries(tree);
  // Only providers holding actual imports render. Stale provider dirs with
  // no galleries stay out. Misc renders on the same terms, pinned last.
  const miscEntry = tree.find((p) => p?.name === MISC_PROVIDER && hasProviderNodes(p));
  const providerRows = tree.filter((p) => p?.name && p.name !== MISC_PROVIDER && hasProviderNodes(p));
  if (miscEntry) providerRows.push(miscEntry);
  const resolved = resolveActiveProvider(tree, prevOrder);

  const displayNames = manifest
    ? new Map((manifest.extractors || []).map((e) => [e.libraryPath, e.name]))
    : null;

  const separator = dropdown.querySelector(':scope > .separator');
  const anchor = separator || dropdown.querySelector(':scope > #import-provider-all');
  const rows = Array.from(dropdown.children).filter((el) => el.classList?.contains('import-provider-item'));

  providerRows.forEach((provider, i) => {
    if (!provider?.name) return;
    let li = rows[i];
    if (!li) {
      li = rowTemplate.content.firstElementChild.cloneNode(true);
      dropdown.insertBefore(li, anchor);
    }
    li.dataset.provider = provider.name;
    li.classList.toggle('checked', resolved === provider.name);
    if (resolved === provider.name) {
      li.setAttribute('aria-current', 'true');
    } else {
      li.removeAttribute('aria-current');
    }
    const label = li.querySelector('.import-provider-label');
    if (label) label.textContent = (displayNames && displayNames.get(provider.name)) || provider.name;
  });

  for (let i = rows.length - 1; i >= providerRows.length; i--) {
    rows[i].remove();
  }

  // No imports, no tab. The menu appears with the first import instead
  // of sitting empty with muted rows.
  if (menuItem) menuItem.hidden = !hasAny;

  const allRow = document.getElementById('import-provider-all');
  if (allRow) {
    allRow.classList.toggle('checked', resolved === null);
  }
}

function bindImportsDropdown() {
  const dropdown = document.getElementById('imports-menu-dropdown');
  if (!dropdown) return;

  dropdown.addEventListener('click', (e) => {
    const allRow = e.target.closest('#import-provider-all');
    if (allRow) {
      e.stopPropagation();
      setActiveProvider(null, { explicit: true });
      renderImportsMenu();
      return;
    }
    const row = e.target.closest('.import-provider-item');
    if (row?.dataset?.provider) {
      e.stopPropagation();
      setActiveProvider(row.dataset.provider, { explicit: true });
      renderImportsMenu();
    }
  });

  dropdown.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const row = e.target.closest('li[role="menuitem"]');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (row.id === 'import-provider-all') {
        setActiveProvider(null, { explicit: true });
      } else if (row.dataset?.provider) {
        setActiveProvider(row.dataset.provider, { explicit: true });
      }
      renderImportsMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const items = Array.from(dropdown.querySelectorAll('li[role="menuitem"]'));
      const idx = items.indexOf(row);
      if (idx !== -1) {
        const nextIdx = e.key === 'ArrowDown'
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
        items[nextIdx].focus();
      }
    }
  });

  window.addEventListener('quivit-library-active-changed', renderImportsMenu);
  window.addEventListener('quivit-library-updated', renderImportsMenu);
  window.addEventListener('quivit-config-loaded', renderImportsMenu);
  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('library-changed', () => {
      renderImportsMenu();
    }).catch(() => {});
  }
}

const FIT_MODE_MAP = {
  'none': 'cmd-fit-none',
  'width': 'cmd-fit-width',
  'height': 'cmd-fit-height',
  'window': 'cmd-fit-best',
  'width-if-larger': 'cmd-fit-width-if-larger',
  'height-if-larger': 'cmd-fit-height-if-larger',
  'window-if-larger': 'cmd-fit-window-if-larger'
};

const FIT_LABELS = {
  'none': 'None',
  'width': 'Width',
  'height': 'Height',
  'window': 'Window',
  'width-if-larger': 'Width if Larger',
  'height-if-larger': 'Height if Larger',
  'window-if-larger': 'Window if Larger'
};

const FILTER_LABELS = {
  'anime4k': 'Anime4K',
  'scanlines': 'Scanlines',
  'phosphor': 'Phosphor',
  'crt': 'Retro CRT'
};

function _setMenuItemDisabled(id, disabled, note = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('muted', disabled);
  el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if (disabled) {
    if (!el.dataset.origTitle && el.title) {
      el.dataset.origTitle = el.title;
    }
    el.title = note;
  } else {
    if (el.dataset.origTitle !== undefined) {
      el.title = el.dataset.origTitle;
      delete el.dataset.origTitle;
    }
  }
}

export function syncViewMenu(state) {
  const isAnimated = !!state.isAnimated;
  // The renderer silently falls back to Bilinear for SVGs.
  // Ignore SVG status here so the user's preferred scaling mode remains visually checked (intended UX).
  const currentFilter = activeFilterId(state.config?.frontend_data || {});
  const displayScaling = getEffectiveScaling(state.scalingMode, isAnimated, false);

  const activeFit = state.fitMode;
  for (const [mode, id] of Object.entries(FIT_MODE_MAP)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('checked', activeFit === mode);
  }

  const fitLabelEl = document.getElementById('fit-current-label');
  if (fitLabelEl) fitLabelEl.textContent = FIT_LABELS[activeFit] || 'Window';

  const scalingLabels = { none: 'Pixelated', bilinear: 'Bilinear', lanczos: 'Lanczos' };
  const currentScalingLabel = scalingLabels[displayScaling] || 'Bilinear';
  const scalingLabelEl = document.getElementById('scaling-current-label');
  if (scalingLabelEl) scalingLabelEl.textContent = currentScalingLabel;

  const filterLabelEl = document.getElementById('filter-current-label');
  if (filterLabelEl) filterLabelEl.textContent = currentFilter ? (FILTER_LABELS[currentFilter] || 'Active') : 'Off';

  const filterOffEl = document.getElementById('cmd-filter-off');
  if (filterOffEl) filterOffEl.classList.toggle('checked', !currentFilter);

  for (const f of FILTERS) {
    const el = document.getElementById(f.actionId);
    if (!el) continue;
    el.classList.toggle('checked', currentFilter === f.id);
  }

  for (const s of SCALERS) {
    const el = document.getElementById(s.actionId);
    if (!el) continue;
    el.classList.toggle('checked', displayScaling === s.id);
  }

  const manhwaOn = !!(state.manhwaEnabled ?? state.config?.frontend_data?.manhwa_enabled);
  const manhwaEl = document.getElementById('cmd-toggle-manhwa');
  if (manhwaEl) {
    manhwaEl.classList.toggle('checked', manhwaOn);
  }

  const manhwaRotationNote = 'Rotation is disabled in Manhwa view';
  for (const id of ['cmd-rotate-cw', 'cmd-rotate-ccw']) {
    _setMenuItemDisabled(id, manhwaOn, manhwaRotationNote);
  }

  const spreadEnabled = !!(state.spreadEnabled ?? state.config?.frontend_data?.spread_enabled);
  const spreadDirection = state.spreadDirection ?? state.config?.frontend_data?.spread_direction ?? 'rtl';

  const spreadLabelEl = document.getElementById('spread-current-label');
  if (spreadLabelEl) {
    spreadLabelEl.textContent = !spreadEnabled ? 'Off' : (spreadDirection === 'ltr' ? 'LTR' : 'RTL');
  }

  const spreadOffEl = document.getElementById('cmd-spread-off');
  if (spreadOffEl) {
    spreadOffEl.classList.toggle('checked', !spreadEnabled);
  }

  const rtlEl = document.getElementById('cmd-spread-direction-rtl');
  if (rtlEl) {
    rtlEl.classList.toggle('checked', spreadEnabled && spreadDirection === 'rtl');
  }

  const ltrEl = document.getElementById('cmd-spread-direction-ltr');
  if (ltrEl) {
    ltrEl.classList.toggle('checked', spreadEnabled && spreadDirection === 'ltr');
  }
}

