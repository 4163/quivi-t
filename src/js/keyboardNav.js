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
