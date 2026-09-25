import fs from 'fs';
import path from 'path';
import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import { fixtures } from '../helpers/fixtures.js';

describe('05 - Persistence & User Preferences', () => {
  const targetDir = process.env.QUIVIT_CONFIG_DIR
    ? path.resolve(process.env.QUIVIT_CONFIG_DIR)
    : path.resolve('src-tauri/target/debug');
  const configPath = path.join(targetDir, 'quivit_config.json');

  before(async () => {
    await menubarPage.ensureMainWindow();
  });

  it('persists view mode switch between list and thumbnail view', async () => {
    // Factory default is list view mode
    expect(await filepanelPage.isThumbnailMode()).toBe(false);

    // Toggle to thumbnail view mode
    await filepanelPage.toggleViewMode();
    expect(await filepanelPage.isThumbnailMode()).toBe(true);

    // Verify view mode persists to config on disk (accounting for 1500ms debounce)
    await browser.waitUntil(
      () => {
        if (!fs.existsSync(configPath)) return false;
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          return cfg.frontend_data?.file_list_view_mode === 'thumbnail';
        } catch {
          return false;
        }
      },
      { timeout: 6000, timeoutMsg: 'Config file did not persist thumbnail view mode to disk' }
    );

    // Allow config-changed watcher event to settle before the next toggle
    await browser.pause(1000);

    // Toggle back to list view mode
    await filepanelPage.toggleViewMode();
    expect(await filepanelPage.isThumbnailMode()).toBe(false);

    await browser.waitUntil(
      () => {
        if (!fs.existsSync(configPath)) return false;
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          return cfg.frontend_data?.file_list_view_mode === 'list';
        } catch {
          return false;
        }
      },
      { timeout: 6000, timeoutMsg: 'Config file did not persist list view mode to disk' }
    );
  });

  it('adds active entry to favorites and persists to store', async () => {
    // Open a test image to populate file panel
    await browser.execute((filePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', filePath);
      }
    }, fixtures.testPng);

    await browser.waitUntil(
      async () => !(await viewerPage.isDropOverlayVisible()),
      { timeout: 8000, timeoutMsg: 'Test image did not load in viewer' }
    );

    await browser.waitUntil(
      async () => {
        const text = await statusbarPage.getFilenameText();
        return text.includes('export_1785518878919.png');
      },
      { timeout: 5000, timeoutMsg: 'Statusbar did not show test image name' }
    );

    // Favorite button becomes enabled once an image entry is active
    await browser.waitUntil(
      async () => {
        const disabled = await filepanelPage.btnFavorite.getAttribute('disabled');
        return !disabled;
      },
      { timeout: 5000, timeoutMsg: 'Favorite button was not enabled' }
    );

    // Toggle favorite on
    await filepanelPage.toggleFavorite();

    await browser.waitUntil(
      async () => await filepanelPage.isFavoriteActive(),
      { timeout: 3000, timeoutMsg: 'Favorite button did not become active' }
    );

    // Favorites list in UI should now display the item
    await browser.waitUntil(
      async () => (await filepanelPage.getFavoriteCount()) > 0,
      { timeout: 5000, timeoutMsg: 'Favorites list did not render added item' }
    );

    // Verify persistence to disk
    await browser.waitUntil(
      () => {
        if (!fs.existsSync(configPath)) return false;
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          return (cfg.frontend_data?.favorites?.length || 0) > 0;
        } catch {
          return false;
        }
      },
      { timeout: 6000, timeoutMsg: 'Favorites were not persisted to config file' }
    );
  });

  it('removes favorite on subsequent toggle and updates persisted store', async () => {
    // Allow config-changed watcher event from previous test to settle
    await browser.pause(1000);

    // Toggle favorite off for the currently selected item
    await filepanelPage.toggleFavorite();

    await browser.waitUntil(
      async () => !(await filepanelPage.isFavoriteActive()),
      { timeout: 3000, timeoutMsg: 'Favorite button did not become inactive' }
    );

    await browser.waitUntil(
      async () => (await filepanelPage.getFavoriteCount()) === 0,
      { timeout: 5000, timeoutMsg: 'Favorites list did not clear after toggling off' }
    );

    // Verify removal persisted to disk
    await browser.waitUntil(
      () => {
        if (!fs.existsSync(configPath)) return false;
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          return (cfg.frontend_data?.favorites?.length || 0) === 0;
        } catch {
          return false;
        }
      },
      { timeout: 6000, timeoutMsg: 'Cleared favorites were not persisted to config file' }
    );
  });
});
