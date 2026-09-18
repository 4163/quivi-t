/**
 * keyboardNav.js
 * Keyboard navigation helpers for element lists.
 */

function isItemNavigable(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  return true;
}

function findNextNavigableIndex(arr, currentIndex, dir, loop) {
  const total = arr.length;
  if (!total) return null;
  let candidate = currentIndex + dir;
  let count = 0;
  while (count < total) {
    if (loop) {
      candidate = (candidate + total) % total;
    } else if (candidate < 0 || candidate >= total) {
      return null;
    }
    if (isItemNavigable(arr[candidate])) {
      return candidate;
    }
    candidate += dir;
    count++;
  }
  return null;
}

function findInitialNavigableIndex(items, dir) {
  const total = items.length;
  if (!total) return null;
  const start = dir > 0 ? 0 : total - 1;
  let curr = start;
  for (let i = 0; i < total; i++) {
    if (isItemNavigable(items[curr])) return curr;
    curr += dir;
    if (curr < 0 || curr >= total) break;
  }
  return null;
}

export function makeListNavigable(elements, options = {}) {
  const { 
    horizontal = true,
    vertical = true,
    loop = true,
  } = options;

  const arr = Array.from(elements);
  arr.forEach((el, index) => {
    el.addEventListener('keydown', (e) => {
      let dir = null;

      if (horizontal && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        e.stopPropagation();
        dir = e.key === 'ArrowRight' ? 1 : -1;
      } else if (vertical && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        dir = e.key === 'ArrowDown' ? 1 : -1;
      }

      if (dir !== null) {
        const nextIndex = findNextNavigableIndex(arr, index, dir, loop);
        if (nextIndex !== null && arr[nextIndex]) {
          arr[nextIndex].focus();
        }
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
          nextIndex = currentIndex === -1
            ? findInitialNavigableIndex(items, 1)
            : findNextNavigableIndex(items, currentIndex, 1, loop);
        }
        break;
      case 'ArrowUp':
        if (vertical) {
          e.preventDefault();
          e.stopPropagation();
          nextIndex = currentIndex === -1
            ? findInitialNavigableIndex(items, -1)
            : findNextNavigableIndex(items, currentIndex, -1, loop);
        }
        break;
      case 'ArrowRight':
        if (horizontal) {
          e.preventDefault();
          e.stopPropagation();
          nextIndex = currentIndex === -1
            ? findInitialNavigableIndex(items, 1)
            : findNextNavigableIndex(items, currentIndex, 1, loop);
        }
        break;
      case 'ArrowLeft':
        if (horizontal) {
          e.preventDefault();
          e.stopPropagation();
          nextIndex = currentIndex === -1
            ? findInitialNavigableIndex(items, -1)
            : findNextNavigableIndex(items, currentIndex, -1, loop);
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
      .filter(el => isItemNavigable(el) && el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).visibility !== 'hidden');
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
