export default class Page {
  async getTitle() {
    return browser.getTitle();
  }

  async ensureMainWindow() {
    const handles = await browser.getWindowHandles();
    if (handles.length > 0) {
      await browser.switchToWindow(handles[0]);
    }
  }

  async switchToWindow(handleOrIndex) {
    if (typeof handleOrIndex === 'number') {
      const handles = await browser.getWindowHandles();
      if (handles[handleOrIndex]) {
        await browser.switchToWindow(handles[handleOrIndex]);
      }
    } else {
      await browser.switchToWindow(handleOrIndex);
    }
  }

  async invokeTauri(command, args = {}) {
    return browser.execute(async (cmd, payload) => {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke(cmd, payload);
      }
      throw new Error('Tauri IPC internals not available in window context');
    }, command, args);
  }
}
