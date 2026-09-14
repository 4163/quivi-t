import Page from './page.js';

class OptionsPage extends Page {
  // Tabs
  get tabGeneral() { return $('.tab-btn[data-target="tab-general"]'); }
  get tabKeys() { return $('.tab-btn[data-target="tab-keys"]'); }
  get tabAssociations() { return $('.tab-btn[data-target="tab-associations"]'); }
  get tabCustomization() { return $('.tab-btn[data-target="tab-customization"]'); }
  get tabLanguage() { return $('.tab-btn[data-target="tab-language"]'); }

  // General tab controls
  get optShowHidden() { return $('#opt-show-hidden'); }
  get optStartDir() { return $('#opt-start-dir'); }
  get btnBrowseStart() { return $('#btn-browse-start'); }
  get optContinueLast() { return $('#opt-continue-last'); }
  get optRememberLastImage() { return $('#opt-remember-last-image'); }
  get optSingleInstance() { return $('#opt-single-instance'); }
  get optHideChromeFullscreen() { return $('#opt-hide-chrome-fullscreen'); }
  get optOpenFirstImage() { return $('#opt-open-first-image'); }
  get optKeyboardPanStep() { return $('#opt-keyboard-pan-step'); }
  get optWheelPanStep() { return $('#opt-wheel-pan-step'); }
  get optHideCursorDelay() { return $('#opt-hide-cursor-delay'); }
  get optPortableMode() { return $('#opt-portable-mode'); }

  // Customization controls
  get themeButtons() { return $$('.theme-btn'); }
  get customCssTextarea() { return $('#opt-custom-css'); }
  get btnApplyCss() { return $('#btn-save-apply-css'); }

  // Footer controls
  get btnSave() { return $('#btn-save-options'); }
  get btnClose() { return $('#btn-cancel'); }
  get statusMessage() { return $('#options-status'); }

  async openOptions() {
    await browser.execute(async () => {
      const el = document.getElementById('cmd-options');
      if (el) el.click();
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('open_options').catch(() => {});
      }
    });
  }

  async switchToOptionsWindow() {
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > 1,
      { timeout: 8000, timeoutMsg: 'Options window handle did not appear' }
    );
    const mainHandle = (await browser.getWindowHandles())[0];
    await browser.waitUntil(
      async () => {
        const handles = await browser.getWindowHandles();
        for (const h of handles) {
          if (h === mainHandle) continue;
          await browser.switchToWindow(h);
          const title = await browser.getTitle();
          const url = await browser.getUrl();
          if (title.includes('Options') || url.includes('options.html')) {
            return true;
          }
        }
        return false;
      },
      { timeout: 8000, timeoutMsg: 'Options window did not finish loading options.html' }
    );
  }

  async selectTab(tabTarget) {
    const tab = await $(`.tab-btn[data-target="${tabTarget}"]`);
    await tab.waitForClickable();
    await tab.click();
  }

  async selectTheme(themeName) {
    await this.selectTab('tab-customization');
    const btn = await $(`.theme-btn[data-theme="${themeName}"]`);
    await btn.waitForClickable();
    await btn.click();
  }

  async save() {
    await this.btnSave.waitForClickable();
    await this.btnSave.click();
  }

  async close() {
    await this.btnClose.waitForClickable();
    await this.btnClose.click();
    try {
      await browser.execute(async () => {
        try {
          const win = window.__TAURI__?.window?.getCurrentWindow?.();
          if (win?.destroy) await win.destroy();
          else if (win?.close) await win.close();
        } catch (e) {}
      });
    } catch {
      // Window already closed by button click
    }
  }
}

export default new OptionsPage();
