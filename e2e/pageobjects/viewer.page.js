import Page from './page.js';

class ViewerPage extends Page {
  get viewport() { return $('#viewport'); }
  get dropOverlay() { return $('#drop-overlay'); }
  get imgWrapper() { return $('#viewer-img-wrapper'); }
  get spreadIndicator() { return $('#spread-indicator'); }
  get images() { return $$('#viewer-img-wrapper img.viewer-img'); }
  get lanczosCanvas() { return $('#viewer-lanczos-canvas'); }
  get filterCanvas() { return $('#viewer-filter-canvas'); }
  get manhwaStrip() { return $('#manhwa-strip'); }
  get manhwaSlots() { return $$('#manhwa-strip .manhwa-slot'); }
  get manhwaTopSpacer() { return $('#manhwa-strip-spacer-top'); }
  get manhwaBottomSpacer() { return $('#manhwa-strip-spacer-bottom'); }
  get manhwaFilterCanvas() { return $('#manhwa-filter-canvas'); }
  get manhwaSvgPumpLayer() { return $('#manhwa-svg-pump-layer'); }
  get manhwaAudioOverlay() { return $('#manhwa-audio-overlay'); }

  async isManhwaActive() {
    const vp = await this.viewport;
    if (!(await vp.isExisting())) return false;
    const classes = await vp.getAttribute('class');
    return classes.includes('manhwa-active');
  }

  async isManhwaFilterCanvasReady() {
    const canvas = await this.manhwaFilterCanvas;
    if (!(await canvas.isExisting())) return false;
    const ready = await canvas.getAttribute('data-render-ready');
    return ready === 'true';
  }

  async getManhwaActiveFilter() {
    const vp = await this.viewport;
    if (!(await vp.isExisting())) return null;
    return vp.getAttribute('data-filter');
  }

  async getManhwaTransform() {
    const strip = await this.manhwaStrip;
    return strip.getCSSProperty('transform');
  }

  async isDropOverlayVisible() {
    const overlay = await this.dropOverlay;
    if (!(await overlay.isExisting())) return false;
    const classes = await overlay.getAttribute('class');
    return classes.includes('active');
  }

  async getTransform() {
    const wrapper = await this.imgWrapper;
    return wrapper.getCSSProperty('transform');
  }

  async getTransformMatrix() {
    const transform = await this.getTransform();
    return transform.value;
  }

  async isSpreadIndicatorVisible() {
    const indicator = await this.spreadIndicator;
    if (!(await indicator.isExisting())) return false;
    const isDisp = await indicator.isDisplayed();
    const text = await indicator.getText();
    return isDisp && text.trim().length > 0;
  }

  async dragPan(startX, startY, endX, endY) {
    await browser.action('pointer')
      .move({ x: startX, y: startY })
      .down()
      .move({ x: endX, y: endY })
      .up()
      .perform();
  }
}

export default new ViewerPage();
