import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import { fixtures } from '../helpers/fixtures.js';

describe('Probe URL Overlay Dismissal', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
    await browser.execute((targetDir) => {
      if (window.__TAURI__?.event?.emit) {
        window.__TAURI__.event.emit('single-instance-open', targetDir);
      }
    }, fixtures.root);

    await browser.waitUntil(
      async () => (await filepanelPage.getItemCount()) > 0,
      { timeout: 10000, timeoutMsg: 'File list failed to populate' }
    );
  });

  beforeEach(async () => {
    // Open URL overlay before each test
    await browser.execute(() => {
      const el = document.getElementById('cmd-use-url');
      if (el) el.click();
    });

    const overlay = await $('#url-overlay');
    await browser.waitUntil(
      async () => (await overlay.getAttribute('class'))?.includes('active'),
      { timeout: 3000, timeoutMsg: 'URL overlay did not become active' }
    );
  });

  it('keeps overlay open when clicking column header cells', async () => {
    const overlay = await $('#url-overlay');
    const headerCell = await $('.header-cell.col-name');
    expect(await headerCell.isDisplayed()).toBe(true);

    await headerCell.click();
    await browser.pause(400);

    const isStillActive = (await overlay.getAttribute('class'))?.includes('active');
    expect(isStillActive).toBe(true);
  });

  it('keeps overlay open when clicking action buttons', async () => {
    const overlay = await $('#url-overlay');
    const toggleBtn = await $('#btn-toggle-view-mode');
    expect(await toggleBtn.isDisplayed()).toBe(true);

    await toggleBtn.click();
    await browser.pause(400);

    const isStillActive = (await overlay.getAttribute('class'))?.includes('active');
    expect(isStillActive).toBe(true);
  });

  it('dismisses overlay when clicking a file list item', async () => {
    const overlay = await $('#url-overlay');
    const firstItem = (await filepanelPage.items)[0];
    expect(await firstItem.isDisplayed()).toBe(true);

    await firstItem.click();
    await browser.waitUntil(
      async () => !(await overlay.getAttribute('class'))?.includes('active'),
      { timeout: 3000, timeoutMsg: 'Overlay did not dismiss when file list item was clicked' }
    );

    const isStillActive = (await overlay.getAttribute('class'))?.includes('active');
    expect(isStillActive).toBe(false);
  });
});
