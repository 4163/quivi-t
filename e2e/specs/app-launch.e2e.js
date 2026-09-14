import { expect } from 'expect-webdriverio';

describe('QuiviT Application Launch', () => {
  before(async () => {
    const handles = await browser.getWindowHandles();
    if (handles.length > 0) {
      await browser.switchToWindow(handles[0]);
    }
  });

  it('should load with the correct window title', async () => {
    await expect(browser).toHaveTitle('QuiviT');
  });

  it('should display the main menubar with root menus', async () => {
    const menubar = await $('#menubar');
    await expect(menubar).toBeDisplayed();

    const fileMenu = await $('#menu-file');
    await expect(fileMenu).toBeDisplayed();

    const folderMenu = await $('#menu-folder');
    await expect(folderMenu).toBeDisplayed();

    const viewMenu = await $('#menu-view');
    await expect(viewMenu).toBeDisplayed();
  });

  it('should render the workspace, viewport, file panel, and statusbar elements', async () => {
    const workspace = await $('#workspace');
    await expect(workspace).toBeDisplayed();

    const viewport = await $('#viewport');
    await expect(viewport).toBeDisplayed();

    const filePanel = await $('#file-panel');
    await expect(filePanel).toBeDisplayed();

    const statusbar = await $('#statusbar');
    await expect(statusbar).toBeExisting();
  });
});
