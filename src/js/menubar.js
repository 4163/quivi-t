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

export function closeMenus() {
  if (!activeMenu) return;
  activeMenu.classList.remove('open');
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
        const firstItem = menu.querySelector('.menu-dropdown li[role="menuitem"]');
        if (firstItem) firstItem.focus();
      }
      if (e.key === 'Escape') {
        closeMenus();
      }
      
      // Arrow navigation.
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

  // Enter and Space support for dropdown <li> items.
  document.querySelectorAll('.menu-dropdown').forEach(dropdown => {
    const items = Array.from(dropdown.querySelectorAll('li[role="menuitem"]'));
    items.forEach((item, index) => {
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMenus();
          const trigger = item.closest('.menu-item').querySelector('.menu-trigger');
          if (trigger) trigger.focus();
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
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          // Pass control back to the menubar triggers.
          e.preventDefault();
          const trigger = item.closest('.menu-item').querySelector('.menu-trigger');
          const event = new KeyboardEvent('keydown', { key: e.key });
          trigger.dispatchEvent(event);
        }
      });
      item.addEventListener('click', (e) => {
        if (item.classList.contains('muted') || item.getAttribute('aria-disabled') === 'true') {
          e.stopPropagation();
          return;
        }
        closeMenus();
      });
    });
  });
}

export function syncViewMenu(state) {
  const isAnimated = !!state.isAnimated;
  // The renderer silently falls back to Bilinear for SVGs.
  // Ignore SVG status here so the user's preferred scaling mode remains visually checked (intended UX).
  const currentFilter = activeFilterId(state.config?.frontend_data || {});
  const displayScaling = getEffectiveScaling(state.scalingMode, isAnimated, false);

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

  const rtlEl = document.getElementById('cmd-spread-direction-rtl');
  if (rtlEl) {
    rtlEl.classList.toggle('checked', spreadDirection === 'rtl');
    rtlEl.classList.toggle('muted', !spreadEnabled);
    rtlEl.setAttribute('aria-disabled', !spreadEnabled ? 'true' : 'false');
  }

  const ltrEl = document.getElementById('cmd-spread-direction-ltr');
  if (ltrEl) {
    ltrEl.classList.toggle('checked', spreadDirection === 'ltr');
    ltrEl.classList.toggle('muted', !spreadEnabled);
    ltrEl.setAttribute('aria-disabled', !spreadEnabled ? 'true' : 'false');
  }
}
