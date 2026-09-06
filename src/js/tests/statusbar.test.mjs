import test from 'node:test';
import assert from 'node:assert/strict';

// Mock browser globals required for Node test environment
const _windowListeners = new Map();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => ({}),
      convertFileSrc: (p) => p
    }
  },
  addEventListener: (event, handler) => {
    if (!_windowListeners.has(event)) _windowListeners.set(event, []);
    _windowListeners.get(event).push(handler);
  },
  removeEventListener: (event, handler) => {
    if (!_windowListeners.has(event)) return;
    const list = _windowListeners.get(event).filter(h => h !== handler);
    _windowListeners.set(event, list);
  },
  dispatchEvent: (event) => {
    const list = _windowListeners.get(event.type || event) || [];
    for (const fn of list) fn(event);
  }
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

class MockElement {
  constructor(id = '', className = '') {
    this.id = id;
    this.className = className;
    this.textContent = '';
    this.title = '';
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
  }
}

const elements = new Map();

function setupMockDom() {
  elements.clear();
  const ids = ['statusbar', 'spread-indicator'];
  const classes = [
    'status-filename',
    'status-dims',
    'status-index',
    'status-zoom',
    'status-fit',
    'status-scroll-zoom',
    'status-spread',
  ];

  for (const id of ids) {
    elements.set(`#${id}`, new MockElement(id, ''));
  }
  for (const cls of classes) {
    elements.set(`.${cls}`, new MockElement('', cls));
  }

  global.document = {
    getElementById: (id) => elements.get(`#${id}`) || null,
    querySelector: (selector) => elements.get(selector) || null,
  };
}

test('Statusbar: init binds elements and update syncs filename for image entry', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const statusName = document.querySelector('.status-filename');
  assert.equal(statusName.textContent, '');

  const mockState = {
    index: 0,
    list: [{ name: 'test_photo.png', path: 'C:/photos/test_photo.png' }],
    src: 'http://quivit.localhost/test_photo.png',
    filename: 'test_photo.png',
    fitMode: 'window',
  };

  Statusbar.update(mockState);
  assert.equal(statusName.textContent, 'test_photo.png');
  assert.equal(statusName.title, 'test_photo.png');
});

test('Statusbar: update writes N/A placeholders for non-image entries', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const statusName = document.querySelector('.status-filename');
  const statusDims = document.querySelector('.status-dims');
  const statusZoom = document.querySelector('.status-zoom');

  const folderState = {
    index: 0,
    list: [{ name: 'Subfolder', path: 'C:/photos/Subfolder', is_dir: true }],
    src: '',
    filename: 'Subfolder',
    fitMode: 'window',
  };

  Statusbar.update(folderState);
  assert.equal(statusName.textContent, 'Subfolder');
  assert.equal(statusDims.textContent, 'N/A');
  assert.equal(statusZoom.textContent, 'N/A');
});

test('Statusbar: setImage with isLoading preserves current filename', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const statusName = document.querySelector('.status-filename');
  statusName.textContent = '01.jpg';

  Statusbar.setImage({ isLoading: true });
  assert.equal(statusName.textContent, '01.jpg');
});

test('Statusbar: setImage writes dimensions, zoom, and filename on completion', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const statusName = document.querySelector('.status-filename');
  const statusDims = document.querySelector('.status-dims');
  const statusZoom = document.querySelector('.status-zoom');

  Statusbar.setImage({ filename: '01.jpg', dims: '1920 × 1080', zoom: 1.5 });
  assert.equal(statusName.textContent, '01.jpg');
  assert.equal(statusDims.textContent, '1920 × 1080');
  assert.equal(statusZoom.textContent, '150%');
});

test('Statusbar: setImage handles error state', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const statusName = document.querySelector('.status-filename');
  const statusDims = document.querySelector('.status-dims');
  const statusZoom = document.querySelector('.status-zoom');

  Statusbar.setImage({ isError: true, filename: 'corrupted.png' });
  assert.equal(statusDims.textContent, 'Error');
  assert.equal(statusZoom.textContent, 'N/A');
  assert.equal(statusName.textContent, 'corrupted.png');
});

test('Statusbar: refresh events toggle refreshing class', async () => {
  setupMockDom();
  const { Statusbar } = await import('../menubar/statusbar.js');
  Statusbar.init();

  const bar = document.getElementById('statusbar');
  assert.equal(bar.classList.contains('refreshing'), false);

  window.dispatchEvent(new CustomEvent('quivit-refresh-start'));
  assert.equal(bar.classList.contains('refreshing'), true);
});
