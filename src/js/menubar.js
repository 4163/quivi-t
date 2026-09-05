/**
 * menubar.js
 * Handles the top menubar and dropdown menus.
 */

let activeMenu = null;

import { FILTERS, SCALERS, activeFilterId } from './services/registry.js';
import { getEffectiveScaling } from './services/viewerMath.js';


export function initMenuBar() {
  bindMenus();
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
          flyout.style.top = '';
          flyout.style.left = '';
          flyout.style.maxHeight = '';
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
      aimState.activeSubmenu.style.top = `${topPos}px`;
      aimState.activeSubmenu.style.left = `${rect.right}px`;
      const maxH = window.innerHeight - topPos - 8;
      aimState.activeSubmenu.style.maxHeight = `${Math.max(120, maxH)}px`;
      const subW = aimState.activeSubmenu.offsetWidth || 180;
      if (rect.right + subW > window.innerWidth) {
        aimState.activeSubmenu.style.left = `${Math.max(0, rect.left - subW)}px`;
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
      flyout.style.top = '';
      flyout.style.left = '';
      flyout.style.maxHeight = '';
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
        menu.classList.add('open');
        activeMenu = menu;
      }
    });

    trigger.addEventListener('mouseenter', () => {
      if (!activeMenu || activeMenu === menu) return;
      closeMenus();
      menu.classList.add('open');
      activeMenu = menu;
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
        menu.classList.add('open');
        activeMenu = menu;
        // Focus the first dropdown item.
        const firstItem = menu.querySelector('.menu-dropdown > li[role="menuitem"]');
        if (firstItem) firstItem.focus();
      }
      if (e.key === 'Escape') {
        closeMenus();
      }
      
      // Arrow navigation between top menubar triggers.
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const triggers = Array.from(document.querySelectorAll('#menubar .menu-trigger'));
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
  document.querySelectorAll('.menu-dropdown').forEach(dropdown => {
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

        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (isSubmenuTrigger) {
            activateItem(item, dropdown);
            item.querySelector('.submenu > li[role="menuitem"]')?.focus();
          } else {
            item.click();
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
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
          const next = items[index + 1] || items[0];
          next.focus();
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = items[index - 1] || items[items.length - 1];
          prev.focus();
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
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
        if (item.classList.contains('muted') || item.getAttribute('aria-disabled') === 'true') {
          e.stopPropagation();
          return;
        }
        closeMenus();
      });
    });
  });
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
  'width-if-larger': 'Width if larger',
  'height-if-larger': 'Height if larger',
  'window-if-larger': 'Window if larger'
};

const FILTER_LABELS = {
  'anime4k': 'Anime4K',
  'scanlines': 'Scanlines',
  'phosphor': 'Phosphor',
  'crt': 'Retro CRT'
};

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

  const spreadEnabled = state.spreadEnabled ?? state.config?.frontend_data?.spread_enabled ?? (state.spreadMode !== 'off');
  const spreadDirection = state.spreadDirection ?? state.config?.frontend_data?.spread_direction ?? 'rtl';

  const toggleSpreadEl = document.getElementById('cmd-toggle-spread');
  if (toggleSpreadEl) {
    toggleSpreadEl.classList.toggle('checked', spreadEnabled);
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

