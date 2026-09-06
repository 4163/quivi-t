import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal document and window mocks for Node test environment
class MockElement {
  constructor(tagName, id = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.classList = {
      contains: (cls) => this.className.split(' ').includes(cls),
      add: (cls) => {
        const set = new Set(this.className.split(' ').filter(Boolean));
        set.add(cls);
        this.className = Array.from(set).join(' ');
      },
      remove: (cls) => {
        const set = new Set(this.className.split(' ').filter(Boolean));
        set.delete(cls);
        this.className = Array.from(set).join(' ');
      },
      toggle: (cls, force) => {
        if (force === undefined) force = !this.classList.contains(cls);
        if (force) this.classList.add(cls);
        else this.classList.remove(cls);
        return force;
      }
    };
    this.parentNode = null;
    this.children = [];
    this.listeners = {};
    this.style = {
      setProperty: () => {},
      removeProperty: () => {}
    };
    this.isContentEditable = false;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector === '#menubar' && curr.id === 'menubar') return curr;
      if (selector.includes('#menubar') && curr.id === 'menubar') return curr;
      if (selector.includes('.menu-dropdown') && curr.classList.contains('menu-dropdown')) return curr;
      if (selector.includes('.menu-item') && curr.classList.contains('menu-item')) return curr;
      if (selector === 'button' && curr.tagName === 'BUTTON') return curr;
      if (selector === 'input' && curr.tagName === 'INPUT') return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  blur() {
    this.blurred = true;
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(e) {
    const list = this.listeners[e.type] || [];
    for (const fn of list) {
      fn(e);
      if (e._stopped) break;
    }
    if (!e._stopped && this.parentNode) {
      this.parentNode.dispatchEvent(e);
    }
  }
}

globalThis.document = {
  querySelector: (sel) => {
    if (sel.includes('.menu-item.open')) return null;
    return null;
  },
  querySelectorAll: () => [],
  activeElement: null
};

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => ({}),
      convertFileSrc: (p) => p
    }
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {}
};

const { bindKeyboardShortcuts } = await import('../shortcuts.js');
const { closeMenus } = await import('../menubar.js');

test('Shortcuts: isInteractiveKeyTarget allows shortcuts on menubar triggers and items', async () => {
  const menubar = new MockElement('nav', 'menubar');
  const menuItem = new MockElement('div', 'menu-view', 'menu-item');
  const triggerBtn = new MockElement('button', '', 'menu-trigger');
  const dropdown = new MockElement('ul', '', 'menu-dropdown');
  const menuLi = new MockElement('li', 'cmd-scale-bilinear');

  menubar.appendChild(menuItem);
  menuItem.appendChild(triggerBtn);
  menuItem.appendChild(dropdown);
  dropdown.appendChild(menuLi);

  let dispatched = [];
  let panned = [];
  const mockCore = {
    getState: () => ({
      config: {
        frontend_data: {
          keybinds: {
            'cmd-scale-bilinear': '2',
            'cmd-fit-width': 'Shift+Q',
            'cmd-pan-up': 'W'
          }
        }
      }
    })
  };

  const listeners = {};
  globalThis.window.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };

  bindKeyboardShortcuts({
    Core: mockCore,
    dispatchAction: (id) => dispatched.push(id),
    dispatchKeyboardPan: (x, y) => panned.push({ x, y })
  });

  const keydown = listeners['keydown'];
  assert.ok(keydown, 'keydown listener should be registered');

  // 1. Keydown on trigger button (e.g. user clicked View)
  globalThis.document.activeElement = triggerBtn;
  let prevented = false;
  keydown({
    type: 'keydown',
    key: '2',
    target: triggerBtn,
    preventDefault: () => { prevented = true; }
  });

  assert.equal(dispatched[0], 'cmd-scale-bilinear', 'Shortcut pressed on menu-trigger must dispatch');
  assert.equal(triggerBtn.blurred, true, 'Menubar trigger must be blurred on shortcut dispatch');

  // 2. Keydown on menu dropdown item (e.g. user arrowed into menu)
  globalThis.document.activeElement = menuLi;
  keydown({
    type: 'keydown',
    key: '2',
    target: menuLi,
    preventDefault: () => {}
  });
  assert.equal(dispatched[1], 'cmd-scale-bilinear', 'Shortcut pressed on menu item must dispatch');

  // 3. Keydown on real form input should NOT dispatch shortcut
  const textInput = new MockElement('input');
  globalThis.document.activeElement = textInput;
  keydown({
    type: 'keydown',
    key: '2',
    target: textInput,
    preventDefault: () => {}
  });
  assert.equal(dispatched.length, 2, 'Shortcut on input field must NOT dispatch');

  // 4. Button outside menubar should allow non-space/enter shortcuts
  const normalBtn = new MockElement('button', 'btn-toggle-view-mode');
  globalThis.document.activeElement = normalBtn;
  keydown({
    type: 'keydown',
    key: '2',
    target: normalBtn,
    preventDefault: () => {}
  });
  assert.equal(dispatched[2], 'cmd-scale-bilinear', 'Non-activating shortcut on standard button must dispatch');

  // But Space / Enter on standard button must be preserved for button click
  keydown({
    type: 'keydown',
    key: ' ',
    target: normalBtn,
    preventDefault: () => {}
  });
  assert.equal(dispatched.length, 3, 'Space on standard button must NOT trigger global shortcut');
});
