import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import { fixtures } from '../helpers/fixtures.js';

describe('01 - Startup & Application Chrome', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
  });

  it('initializes window chrome with correct title and elements', async () => {
    await expect(browser).toHaveTitle('QuiviT');
    await expect(menubarPage.menubar).toBeDisplayed();
    await expect(menubarPage.fileMenu).toBeDisplayed();
    await expect(menubarPage.folderMenu).toBeDisplayed();
    await expect(menubarPage.viewMenu).toBeDisplayed();
    await expect(filepanelPage.filePanel).toBeDisplayed();
    await expect(viewerPage.viewport).toBeDisplayed();
  });

  it('displays the drop overlay in empty initial state', async () => {
    const isOverlayActive = await viewerPage.isDropOverlayVisible();
    expect(isOverlayActive).toBe(true);
  });

  it('loads file and hides drop overlay on single-instance-open event', async () => {
    await browser.execute((filePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', filePath);
      }
    }, fixtures.testPng);

    // Wait for the image to load and drop overlay to hide
    await browser.waitUntil(
      async () => !(await viewerPage.isDropOverlayVisible()),
      { timeout: 10000, timeoutMsg: 'Drop overlay did not dismiss after single-instance-open' }
    );

    // File panel should now contain items
    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(0);

    // Statusbar should display the loaded image name
    const filename = await statusbarPage.getFilenameText();
    expect(filename).toContain('export_1785518878919.png');
  });
});
