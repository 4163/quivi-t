import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import passwordModalPage from '../pageobjects/password-modal.page.js';
import { fixtures } from '../helpers/fixtures.js';

describe('04 - Archive Formats & Security', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
    await browser.waitUntil(
      async () => {
        return (await viewerPage.viewport.isDisplayed()) &&
          (await browser.execute(() => typeof window.__TAURI__?.event?.emit === 'function'));
      },
      { timeout: 8000, timeoutMsg: 'Main window and Tauri runtime not ready' }
    );
  });

  it('loads CBZ / ZIP archives and renders entry list', async () => {
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.cbz);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('cbz.cbz');
      },
      { timeout: 10000, timeoutMsg: 'CBZ archive failed to load' }
    );

    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);

    // Select the first image inside the archive
    await filepanelPage.selectItemByIndex(1);

    await browser.waitUntil(
      async () => !(await viewerPage.isDropOverlayVisible()),
      { timeout: 8000, timeoutMsg: 'Drop overlay did not dismiss after selecting image' }
    );
  });

  it('loads CBR / RAR archives', async () => {
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.cbr);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('cbr.cbr');
      },
      { timeout: 10000, timeoutMsg: 'CBR archive failed to load' }
    );

    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);
  });

  it('loads CB7 / 7Z archives', async () => {
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.cb7);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('cb7.cb7');
      },
      { timeout: 10000, timeoutMsg: 'CB7 archive failed to load' }
    );

    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);
  });

  it('loads CBT / TAR archives', async () => {
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.tar);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('tar.tar');
      },
      { timeout: 10000, timeoutMsg: 'TAR archive failed to load' }
    );

    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);
  });

  it('decodes CJK archive entry names correctly', async () => {
    // Shift-JIS ZIP
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.shiftJisZip);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('shift_jis_test.zip');
      },
      { timeout: 8000, timeoutMsg: 'Shift-JIS ZIP failed to load' }
    );

    const shiftJisNames = await filepanelPage.getItemNames();
    expect(shiftJisNames.some(n => n.includes('テスト'))).toBe(true);

    // GBK ZIP
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.gbkZip);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('gbk_test.zip');
      },
      { timeout: 8000, timeoutMsg: 'GBK ZIP failed to load' }
    );

    const gbkNames = await filepanelPage.getItemNames();
    expect(gbkNames.some(n => n.includes('测试'))).toBe(true);

    // EUC-KR ZIP
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.eucKrZip);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('euckr_test.zip');
      },
      { timeout: 8000, timeoutMsg: 'EUC-KR ZIP failed to load' }
    );

    const eucKrNames = await filepanelPage.getItemNames();
    expect(eucKrNames.some(n => n.includes('테스트'))).toBe(true);
  });

  it('prompts password modal on encrypted archives and unlocks on submit', async () => {
    await browser.execute((archivePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }
    }, fixtures.encryptedZip);

    // Password modal should be displayed
    await browser.waitUntil(
      async () => await passwordModalPage.isVisible(),
      { timeout: 8000, timeoutMsg: 'Password modal did not appear for encrypted archive' }
    );

    // Unlock with password '123'
    await passwordModalPage.unlockWith('123');

    // Password overlay should dismiss
    await browser.waitUntil(
      async () => !(await passwordModalPage.isVisible()),
      { timeout: 8000, timeoutMsg: 'Password modal did not dismiss after entering correct password' }
    );

    // Archive contents should now be visible
    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);
  });

  it('completes scan_container_max_width and scan_container_dimensions on a CBZ archive', async () => {
    const widthResult = await browser.executeAsync((archivePath, done) => {
      let unlisten = null;
      const timer = setTimeout(() => {
        if (unlisten) unlisten();
        done({ timedOut: true, maxWidth: 0 });
      }, 10000);

      window.__TAURI__.event.listen('manhwa-max-width', (event) => {
        const payload = event.payload || {};
        if (payload.container !== archivePath) return;
        if (payload.done) {
          clearTimeout(timer);
          if (unlisten) unlisten();
          done({ timedOut: false, maxWidth: payload.max_width || 0 });
        }
      }).then((fn) => {
        unlisten = fn;
        return window.__TAURI__.core.invoke('scan_container_max_width', {
          container: archivePath,
          isArchive: true,
          password: null,
        });
      }).catch((err) => {
        clearTimeout(timer);
        if (unlisten) unlisten();
        done({ error: String(err) });
      });
    }, fixtures.cbz);

    expect(widthResult.error).toBeUndefined();
    expect(widthResult.timedOut).toBe(false);
    expect(widthResult.maxWidth).toBeGreaterThan(0);

    const dimsResult = await browser.executeAsync((archivePath, done) => {
      let unlisten = null;
      const entries = [];
      const timer = setTimeout(() => {
        if (unlisten) unlisten();
        done({ timedOut: true, count: entries.length });
      }, 10000);

      window.__TAURI__.event.listen('container-dimensions', (event) => {
        const payload = event.payload || {};
        if (payload.container !== archivePath) return;
        if (Array.isArray(payload.entries)) {
          entries.push(...payload.entries);
        }
        if (payload.done) {
          clearTimeout(timer);
          if (unlisten) unlisten();
          done({ timedOut: false, count: entries.length });
        }
      }).then((fn) => {
        unlisten = fn;
        return window.__TAURI__.core.invoke('scan_container_dimensions', {
          container: archivePath,
          isArchive: true,
          password: null,
        });
      }).catch((err) => {
        clearTimeout(timer);
        if (unlisten) unlisten();
        done({ error: String(err) });
      });
    }, fixtures.cbz);

    expect(dimsResult.error).toBeUndefined();
    expect(dimsResult.timedOut).toBe(false);
    expect(dimsResult.count).toBeGreaterThan(0);
  });
});
