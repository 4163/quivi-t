/**
 * keyboardNav.js
 * Keyboard navigation helpers for element lists.
 */

export function makeListNavigable(elements, options = {}) {
  const { 
    horizontal = true,
    vertical = true,
    loop = true,
  } = options;

  Array.from(elements).forEach((el, index, arr) => {
    el.addEventListener('keydown', (e) => {
      let nextIndex = null;

      if (horizontal && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        nextIndex = index + dir;
      } else if (vertical && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        nextIndex = index + dir;
      }

      if (nextIndex !== null) {
        if (loop) {
          nextIndex = (nextIndex + arr.length) % arr.length;
        } else {
          nextIndex = Math.max(0, Math.min(nextIndex, arr.length - 1));
        }
        arr[nextIndex].focus();
      }
    });
  });
}

/**
 * Event-delegated navigation for dynamic lists, such as file panels.
 * Listens on `containerEl`, finds items matching `itemSelector`.
 */
export function makeContainerNavigable(containerEl, itemSelector, options = {}) {
  const {
    horizontal = false,
    vertical = true,
    loop = false,
    onAction = null,
    onCancel = null,
    onSelectionChange = null,
  } = options;

  containerEl.addEventListener('keydown', (e) => {
    const items = Array.from(containerEl.querySelectorAll(itemSelector));
    if (!items.length) return;

    const activeEl = document.activeElement && document.activeElement.closest(itemSelector);
    const currentIndex = (activeEl && containerEl.contains(activeEl)) ? items.indexOf(activeEl) : -1;
    let nextIndex = null;

    switch (e.key) {
      case 'ArrowDown':
        if (vertical) {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex === -1) nextIndex = 0;
          else nextIndex = loop ? (currentIndex + 1) % items.length : Math.min(currentIndex + 1, items.length - 1);
        }
        break;
      case 'ArrowUp':
        if (vertical) {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex === -1) nextIndex = items.length - 1;
          else nextIndex = loop ? (currentIndex - 1 + items.length) % items.length : Math.max(currentIndex - 1, 0);
        }
        break;
      case 'ArrowRight':
        if (horizontal) {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex === -1) nextIndex = 0;
          else nextIndex = loop ? (currentIndex + 1) % items.length : Math.min(currentIndex + 1, items.length - 1);
        }
        break;
      case 'ArrowLeft':
        if (horizontal) {
          e.preventDefault();
          e.stopPropagation();
          if (currentIndex === -1) nextIndex = items.length - 1;
          else nextIndex = loop ? (currentIndex - 1 + items.length) % items.length : Math.max(currentIndex - 1, 0);
        }
        break;
      case 'Enter':
      case ' ':
        if (onAction && currentIndex !== -1) {
          // Child controls keep their native Enter handling.
          if (document.activeElement !== items[currentIndex] && document.activeElement.matches('button, input, [role="button"]')) {
            break;
          }
          e.preventDefault();
          e.stopPropagation();
          onAction(currentIndex, items[currentIndex], e);
        }
        break;
      case 'Escape':
        if (onCancel) {
          e.preventDefault();
          e.stopPropagation();
          onCancel(e);
        }
        break;
    }

    if (nextIndex !== null) {
      if (onSelectionChange) {
        onSelectionChange(nextIndex, items[nextIndex]);
      } else {
        items[nextIndex].focus();
      }
    }
  });
}

export function handleTabJump(e) {
  if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && (e.key === 'Home' || e.key === 'End')) {
    const tabbables = Array.from(document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).visibility !== 'hidden');
    if (tabbables.length > 0) {
      if (e.key === 'Home') {
        e.preventDefault();
        tabbables[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        tabbables[tabbables.length - 1].focus();
      }
    }
  }
}
