import Page from './page.js';

class FilepanelPage extends Page {
  get filePanel() { return $('#file-panel'); }
  get breadcrumb() { return $('#file-panel-breadcrumb'); }
  get fileList() { return $('#file-list'); }
  get items() { return $$('#file-list li:not([aria-hidden="true"])'); }
  get selectedItem() { return $('#file-list li.selected'); }

  get btnToggleViewMode() { return $('#btn-toggle-view-mode'); }
  get btnOpenExplorer() { return $('#cmd-open-explorer'); }
  get btnOpenFolder() { return $('#cmd-open-folder'); }
  get btnBookmark() { return $('#btn-bookmark-current'); }
  get btnMetadataBadge() { return $('#status-metadata-badge'); }
  get bookmarksList() { return $('#bookmarks-list'); }
  get bookmarksHeader() { return $('#file-panel-bookmarks-header'); }
  get bookmarkItems() { return $$('#bookmarks-list li'); }

  async isBookmarkActive() {
    const classes = (await this.btnBookmark.getAttribute('class')) || '';
    return classes.includes('active');
  }

  async getBookmarkCount() {
    const items = await this.bookmarkItems;
    return items.length;
  }

  async toggleBookmark() {
    await this.btnBookmark.click();
  }

  async isThumbnailMode() {
    const classes = (await this.filePanel.getAttribute('class')) || '';
    return classes.includes('view-mode-thumbnail');
  }

  async toggleViewMode() {
    await this.btnToggleViewMode.click();
  }

  async getItemCount() {
    const items = await this.items;
    return items.length;
  }

  async getItemNames() {
    const items = await this.items;
    const names = [];
    for (const item of items) {
      const nameEl = await item.$('.item-label, .item-thumbnail-title');
      if (await nameEl.isExisting()) {
        names.push(await nameEl.getText());
      }
    }
    return names;
  }

  async selectItemByName(name) {
    const items = await this.items;
    for (const item of items) {
      const nameEl = await item.$('.item-label, .item-thumbnail-title');
      if (await nameEl.isExisting()) {
        const text = await nameEl.getText();
        if (text.includes(name)) {
          await item.click();
          return;
        }
      }
    }
    throw new Error(`Item "${name}" not found in file list`);
  }

  async selectItemByIndex(index) {
    const items = await this.items;
    if (items[index]) {
      await items[index].click();
      return;
    }
    throw new Error(`Item index ${index} out of bounds (${items.length} total items)`);
  }

  async openItemByName(name) {
    await this.selectItemByName(name);
    await browser.keys(['Enter']);
  }

  async openItemByIndex(index) {
    await this.selectItemByIndex(index);
    await browser.keys(['Enter']);
  }

  async getSelectedText() {
    const selected = await this.selectedItem;
    if (await selected.isExisting()) {
      const label = await selected.$('.item-label, .item-thumbnail-title');
      if (await label.isExisting()) {
        return label.getText();
      }
    }
    return null;
  }
}

export default new FilepanelPage();
