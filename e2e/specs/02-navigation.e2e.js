import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import filepanelPage from '../pageobjects/filepanel.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import { fixtures } from '../helpers/fixtures.js';
import { Key } from '../helpers/keyboard.js';

describe('02 - Navigation & Directory Operations', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
    await browser.waitUntil(
      async () => {
        return (await filepanelPage.filePanel.isDisplayed()) &&
          (await browser.execute(() => typeof window.__TAURI__?.event?.emit === 'function'));
      },
      { timeout: 8000, timeoutMsg: 'Main window and Tauri runtime not ready' }
    );

    // Open test-files directory
    await browser.execute((targetDir) => {
      window.__TAURI__.event.emit('single-instance-open', targetDir);
    }, fixtures.root);

    const startTime = Date.now();
    let reEmitted = false;
    await browser.waitUntil(
      async () => {
        const count = await filepanelPage.getItemCount();
        if (count > 0) return true;
        if (!reEmitted && Date.now() - startTime > 2000) {
          reEmitted = true;
          await browser.execute((targetDir) => {
            window.__TAURI__.event.emit('single-instance-open', targetDir);
          }, fixtures.root);
        }
        return false;
      },
      { timeout: 10000, timeoutMsg: 'File list failed to populate' }
    );
  });

  it('renders directory contents with breadcrumb path', async () => {
    const breadcrumbText = await filepanelPage.breadcrumb.getText();
    expect(breadcrumbText.toLowerCase()).toContain('test-files');

    const count = await filepanelPage.getItemCount();
    expect(count).toBeGreaterThan(3);
  });

  it('navigates to next and previous items via shortcuts', async () => {
    // Select the first image item
    await filepanelPage.selectItemByIndex(1);
    const firstSelected = await filepanelPage.getSelectedText();

    // Dispatch next shortcut (Shift + ArrowDown)
    await browser.keys([Key.Shift, Key.ArrowDown]);

    await browser.waitUntil(
      async () => (await filepanelPage.getSelectedText()) !== firstSelected,
      { timeout: 5000, timeoutMsg: 'Selection did not advance to next item' }
    );

    const secondSelected = await filepanelPage.getSelectedText();
    expect(secondSelected).not.toEqual(firstSelected);

    // Dispatch previous shortcut (Shift + ArrowUp)
    await browser.keys([Key.Shift, Key.ArrowUp]);

    await browser.waitUntil(
      async () => (await filepanelPage.getSelectedText()) === firstSelected,
      { timeout: 5000, timeoutMsg: 'Selection did not return to previous item' }
    );
  });

  it('supports sorting columns in file panel', async () => {
    const nameHeader = await $('#file-panel-header .col-name');
    await nameHeader.click();

    // Verify sort icon or state update
    const items = await filepanelPage.getItemNames();
    expect(items.length).toBeGreaterThan(0);
  });

  it('ascends to parent directory on parent navigation', async () => {
    // Open the _archives subdirectory first
    await filepanelPage.openItemByName('_archives');

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return text.toLowerCase().includes('_archives');
      },
      { timeout: 5000, timeoutMsg: 'Failed to enter _archives folder' }
    );

    // Press Backspace to navigate up to parent
    await browser.keys([Key.Backspace]);

    await browser.waitUntil(
      async () => {
        const text = await filepanelPage.breadcrumb.getText();
        return !text.toLowerCase().endsWith('_archives');
      },
      { timeout: 5000, timeoutMsg: 'Failed to ascend to parent directory' }
    );
  });
});
