import Page from './page.js';

class StatusbarPage extends Page {
  get statusbar() { return $('#statusbar'); }
  get filename() { return $('#statusbar .status-filename'); }
  get scrollZoom() { return $('#statusbar .status-scroll-zoom'); }
  get spread() { return $('#statusbar .status-spread'); }
  get manhwa() { return $('#statusbar .status-manhwa'); }
  get dims() { return $('#statusbar .status-dims'); }
  get index() { return $('#statusbar .status-index'); }
  get zoom() { return $('#statusbar .status-zoom'); }
  get fit() { return $('#statusbar .status-fit'); }
  get scaling() { return $('#statusbar .status-scaling'); }
  get filter() { return $('#statusbar .status-filter'); }
  get version() { return $('#statusbar .status-version'); }

  async isVisible() {
    const bar = await this.statusbar;
    if (!(await bar.isExisting())) return false;
    const classes = await bar.getAttribute('class');
    return !classes.includes('hidden') && (await bar.isDisplayed());
  }

  async getFilenameText() {
    return this.filename.getText();
  }

  async getDimsText() {
    return this.dims.getText();
  }

  async getIndexText() {
    return this.index.getText();
  }

  async getZoomText() {
    return this.zoom.getText();
  }

  async getFitText() {
    return this.fit.getText();
  }

  async getScalingText() {
    return this.scaling.getText();
  }

  async getFilterText() {
    return this.filter.getText();
  }

  async getManhwaText() {
    return this.manhwa.getText();
  }
}

export default new StatusbarPage();
