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

  it('renders short-column encrypted archives in manhwa mode when selecting an image', async () => {
    const toggleManhwa = async () => {
      await browser.execute(() => {
        document.getElementById('cmd-toggle-manhwa')?.click();
      });
    };

    const waitForManhwaImage = async (label) => {
      await browser.waitUntil(
        async () => !(await viewerPage.isDropOverlayVisible()),
        { timeout: 8000, timeoutMsg: `Drop overlay did not dismiss for ${label}` }
      );
      await browser.waitUntil(
        async () => {
          return await browser.execute(() => {
            const img = document.querySelector('#manhwa-strip .manhwa-slot img');
            return Boolean(img && img.complete && img.naturalWidth > 0);
          });
        },
        { timeout: 8000, timeoutMsg: `Manhwa slot image did not render for ${label}` }
      );
    };

    try {
      if (!(await viewerPage.isManhwaActive())) {
        await toggleManhwa();
        await browser.waitUntil(
          async () => await viewerPage.isManhwaActive(),
          { timeout: 5000, timeoutMsg: 'Viewport did not gain manhwa-active class' }
        );
      }

      // Locked encrypted RAR: unlock via modal, then select image in short-column strip
      await browser.execute((archivePath) => {
        window.__TAURI__.event.emit('single-instance-open', archivePath);
      }, fixtures.encryptedRar);

      await browser.waitUntil(
        async () => await passwordModalPage.isVisible(),
        { timeout: 8000, timeoutMsg: 'Password modal did not appear for encrypted RAR' }
      );
      await passwordModalPage.unlockWith('123');
      await browser.waitUntil(
        async () => !(await passwordModalPage.isVisible()),
        { timeout: 8000, timeoutMsg: 'Password modal did not dismiss for encrypted RAR' }
      );

      await browser.waitUntil(
        async () => {
          const text = await filepanelPage.breadcrumb.getText();
          return text.toLowerCase().includes('encrypted-123.rar') && (await filepanelPage.getItemCount()) > 1;
        },
        { timeout: 10000, timeoutMsg: 'Encrypted RAR failed to load in manhwa mode' }
      );

      await filepanelPage.selectItemByIndex(1);
      await waitForManhwaImage('encrypted-123.rar');

      // Already-unlocked encrypted ZIP: reopen in manhwa mode and select image.
      // If run in isolation (without the prior test having unlocked encryptedZip),
      // unlock it first, switch away, and reopen to exercise the cached-password path.
      const openArchive = async (archivePath) => {
        await browser.execute((path) => {
          window.__TAURI__.event.emit('single-instance-open', path);
        }, archivePath);
      };

      const waitForArchiveLoaded = async (nameFragment, label, minCount = 2) => {
        await browser.waitUntil(
          async () => {
            const text = await filepanelPage.breadcrumb.getText();
            return text.toLowerCase().includes(nameFragment) && (await filepanelPage.getItemCount()) >= minCount;
          },
          { timeout: 10000, timeoutMsg: `${label} failed to load in manhwa mode` }
        );
      };

      await openArchive(fixtures.encryptedZip);

      let promptedForZip = false;
      await browser.waitUntil(
        async () => {
          if (await passwordModalPage.isVisible()) {
            promptedForZip = true;
            return true;
          }
          const text = await filepanelPage.breadcrumb.getText();
          return text.toLowerCase().includes('encrypted-123.zip') && (await filepanelPage.getItemCount()) > 1;
        },
        { timeout: 10000, timeoutMsg: 'Encrypted ZIP neither prompted for password nor loaded in manhwa mode' }
      );

      if (promptedForZip) {
        await passwordModalPage.unlockWith('123');
        await browser.waitUntil(
          async () => !(await passwordModalPage.isVisible()),
          { timeout: 8000, timeoutMsg: 'Password modal did not dismiss for encrypted ZIP' }
        );
        await waitForArchiveLoaded('encrypted-123.zip', 'Encrypted ZIP');

        await openArchive(fixtures.cbz);
        await waitForArchiveLoaded('cbz.cbz', 'CBZ', 1);

        await openArchive(fixtures.encryptedZip);
        await waitForArchiveLoaded('encrypted-123.zip', 'Encrypted ZIP');
      }

      await filepanelPage.selectItemByIndex(1);
      await waitForManhwaImage('encrypted-123.zip');
    } finally {
      if (await viewerPage.isManhwaActive()) {
        await toggleManhwa();
        await browser.waitUntil(
          async () => !(await viewerPage.isManhwaActive()),
          { timeout: 5000, timeoutMsg: 'Viewport did not lose manhwa-active class' }
        );
      }
    }
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
