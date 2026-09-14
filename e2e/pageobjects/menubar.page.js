import Page from './page.js';

class MenubarPage extends Page {
  get menubar() { return $('#menubar'); }
  get fileMenu() { return $('#menu-file'); }
  get fileTrigger() { return $('#menu-file .menu-trigger'); }
  get folderMenu() { return $('#menu-folder'); }
  get folderTrigger() { return $('#menu-folder .menu-trigger'); }
  get viewMenu() { return $('#menu-view'); }
  get viewTrigger() { return $('#menu-view .menu-trigger'); }

  // File menu items
  get cmdOpenDir() { return $('#cmd-open-dir'); }
  get cmdOpenFile() { return $('#cmd-open-file'); }
  get cmdOptions() { return $('#cmd-options'); }
  get cmdQuit() { return $('#cmd-quit'); }

  // Folder menu items
  get cmdHistoryBack() { return $('#cmd-history-back'); }
  get cmdHistoryForward() { return $('#cmd-history-forward'); }
  get cmdNext() { return $('#cmd-next'); }
  get cmdPrev() { return $('#cmd-prev'); }
  get cmdOpenNextContainer() { return $('#cmd-open-next-container'); }
  get cmdOpenPrevContainer() { return $('#cmd-open-prev-container'); }
  get cmdParent() { return $('#cmd-parent'); }
  get cmdRefresh() { return $('#cmd-refresh'); }

  // View menu items
  get cmdZoomIn() { return $('#cmd-zoom-in'); }
  get cmdZoomOut() { return $('#cmd-zoom-out'); }
  get cmdZoom100() { return $('#cmd-zoom-100'); }
  get cmdFitNone() { return $('#cmd-fit-none'); }
  get cmdFitWidth() { return $('#cmd-fit-width'); }
  get cmdFitHeight() { return $('#cmd-fit-height'); }
  get cmdFitBest() { return $('#cmd-fit-best'); }
  get cmdFitWidthIfLarger() { return $('#cmd-fit-width-if-larger'); }
  get cmdFitHeightIfLarger() { return $('#cmd-fit-height-if-larger'); }
  get cmdFitWindowIfLarger() { return $('#cmd-fit-window-if-larger'); }

  get scalingCurrentLabel() { return $('#scaling-current-label'); }
  get filterCurrentLabel() { return $('#filter-current-label'); }
  get spreadCurrentLabel() { return $('#spread-current-label'); }

  get cmdSpreadOff() { return $('#cmd-spread-off'); }
  get cmdSpreadRtl() { return $('#cmd-spread-direction-rtl'); }
  get cmdSpreadLtr() { return $('#cmd-spread-direction-ltr'); }

  get cmdToggleFilelist() { return $('#cmd-toggle-filelist'); }
  get cmdToggleMenubar() { return $('#cmd-toggle-menubar'); }
  get cmdToggleStatusbar() { return $('#cmd-toggle-statusbar'); }
  get cmdFullscreen() { return $('#cmd-fullscreen'); }

  async openFileMenu() {
    await this.fileTrigger.click();
  }

  async openFolderMenu() {
    await this.folderTrigger.click();
  }

  async openViewMenu() {
    await this.viewTrigger.click();
  }

  async clickItem(itemElement) {
    await itemElement.waitForClickable();
    await itemElement.click();
  }

  async selectSpreadMode(mode) {
    let targetId;
    if (mode === 'rtl') targetId = 'cmd-spread-direction-rtl';
    else if (mode === 'ltr') targetId = 'cmd-spread-direction-ltr';
    else targetId = 'cmd-spread-off';

    await browser.execute((id) => {
      const el = document.getElementById(id);
      if (el) el.click();
    }, targetId);
  }
}

export default new MenubarPage();
