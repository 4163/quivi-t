import Page from './page.js';

class ViewerPage extends Page {
  get viewport() { return $('#viewport'); }
  get dropOverlay() { return $('#drop-overlay'); }
  get imgWrapper() { return $('#viewer-img-wrapper'); }
  get spreadIndicator() { return $('#spread-indicator'); }
  get images() { return $$('#viewer-img-wrapper img.viewer-img'); }
  get lanczosCanvas() { return $('#viewer-lanczos-canvas'); }
  get filterCanvas() { return $('#viewer-filter-canvas'); }

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
