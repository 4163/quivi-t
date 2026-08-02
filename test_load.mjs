global.window = {
  __TAURI__: {
    core: {
      invoke: async () => {},
      convertFileSrc: () => ''
    },
    event: { listen: async () => {} },
    dialog: { open: async () => {} }
  },
  addEventListener: () => {},
  document: {
    documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
    getElementById: () => ({ 
      addEventListener: () => {}, 
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      getBoundingClientRect: () => ({ width: 100 })
    }),
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  navigator: { userAgent: '' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  URL: { revokeObjectURL: () => {} }
};
global.document = window.document;
global.localStorage = window.localStorage;
global.window.document = window.document;

import('./src/js/main.js').then(() => {
  console.log("All modules loaded successfully without ReferenceErrors!");
}).catch(err => {
  console.error("Error loading modules:", err);
});
