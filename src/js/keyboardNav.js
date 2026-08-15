/**
 * keyboardNav.js
 * Utility for making lists of elements keyboard navigable (Arrow keys, Home, End).
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
 * Event-delegation based navigation for dynamic lists (e.g. file panels).
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
          // Only trigger onAction if the key isn't being caught by an interactive child element like a button
          if (!document.activeElement.matches('button, input, [role="button"]')) {
            e.preventDefault();
            e.stopPropagation();
            onAction(currentIndex, items[currentIndex], e);
          } else if (document.activeElement.matches('button.fav-remove')) {
            // Special case for our fav-remove button: let it handle its own click
            // but we don't preventDefault so the browser triggers the click.
          } else {
             e.preventDefault();
             e.stopPropagation();
             onAction(currentIndex, items[currentIndex], e);
          }
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
