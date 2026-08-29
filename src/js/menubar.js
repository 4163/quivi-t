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
      item.addEventListener('click', closeMenus);
    });
  });
}

export function syncViewMenu(state) {
  const isAnimated = !!state.isAnimated;
  const isSvg = state.currentFile ? state.currentFile.name.toLowerCase().endsWith('.svg') : false;
  const currentFilter = activeFilterId(state.config?.frontend_data || {});
  const displayScaling = getEffectiveScaling(state.scalingMode, isAnimated, isSvg);

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
}
