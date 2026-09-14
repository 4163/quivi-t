import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import viewerPage from '../pageobjects/viewer.page.js';
import statusbarPage from '../pageobjects/statusbar.page.js';
import { fixtures } from '../helpers/fixtures.js';
import { Key, shift } from '../helpers/keyboard.js';

describe('03 - Viewport & Viewer Controls', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
    await browser.waitUntil(
      async () => {
        return (await viewerPage.viewport.isDisplayed()) &&
          (await browser.execute(() => typeof window.__TAURI__?.event?.emit === 'function'));
      },
      { timeout: 8000, timeoutMsg: 'Main window and Tauri runtime not ready' }
    );

    // Open single test image to ensure viewer is active
    await browser.execute((filePath) => {
      window.__TAURI__.event.emit('single-instance-open', filePath);
    }, fixtures.testPng);

    const startTime = Date.now();
    let reEmitted = false;
    await browser.waitUntil(
      async () => {
        const overlayVisible = await viewerPage.isDropOverlayVisible();
        if (!overlayVisible) return true;
        if (!reEmitted && Date.now() - startTime > 2000) {
          reEmitted = true;
          await browser.execute((filePath) => {
            window.__TAURI__.event.emit('single-instance-open', filePath);
          }, fixtures.testPng);
        }
        return false;
      },
      { timeout: 10000, timeoutMsg: 'Image failed to load into viewport' }
    );
  });

  it('switches fit modes and updates viewport transforms', async () => {
    // Switch to Fit: None (1:1)
    await browser.keys(['r']);
    await browser.waitUntil(
      async () => (await statusbarPage.getFitText()).includes('None'),
      { timeout: 5000, timeoutMsg: 'Fit None was not applied' }
    );
    const transformNone = await viewerPage.getTransformMatrix();

    // Switch to Fit: Width (Shift + Q)
    await shift('q');
    await browser.waitUntil(
      async () => (await statusbarPage.getFitText()).includes('Width'),
      { timeout: 5000, timeoutMsg: 'Fit Width was not applied' }
    );
    const transformWidth = await viewerPage.getTransformMatrix();
    expect(transformWidth).not.toEqual(transformNone);

    // Switch to Fit: Height (Shift + E)
    await shift('e');
    await browser.waitUntil(
      async () => (await statusbarPage.getFitText()).includes('Height'),
      { timeout: 5000, timeoutMsg: 'Fit Height was not applied' }
    );
    const transformHeight = await viewerPage.getTransformMatrix();
    expect(transformHeight).not.toEqual(transformWidth);

    // Switch to Fit: Window (Shift + F)
    await shift('f');
    await browser.waitUntil(
      async () => (await statusbarPage.getFitText()).includes('Window'),
      { timeout: 5000, timeoutMsg: 'Fit Window was not applied' }
    );
  });

  it('zooms in, zooms out, and updates zoom readout', async () => {
    // Zoom in using 'c'
    await browser.keys(['c']);
    await browser.keys(['c']);

    const zoomText = await statusbarPage.getZoomText();
    expect(zoomText).toMatch(/%$/);

    const transformZoomed = await viewerPage.getTransformMatrix();

    // Reset zoom with 'x' (Zoom 100%)
    await browser.keys(['x']);
    const transformReset = await viewerPage.getTransformMatrix();
    expect(transformReset).not.toEqual(transformZoomed);
  });

  it('pans the image using keyboard controls', async () => {
    // Set 1:1 None fit so image exceeds viewport for panning
    await browser.keys(['r']);
    await browser.keys(['c']); // zoom in slightly
    const initialTransform = await viewerPage.getTransformMatrix();

    // Pan right with 'd'
    await browser.keys(['d']);
    await browser.keys(['d']);

    const pannedTransform = await viewerPage.getTransformMatrix();
    expect(pannedTransform).not.toEqual(initialTransform);
  });

  it('activates spread mode on wide images', async () => {
    // Load a wide spread image
    await browser.execute((filePath) => {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('single-instance-open', filePath);
      }
    }, fixtures.testSpread);

    await browser.waitUntil(
      async () => (await statusbarPage.getFilenameText()).includes('spread_test_white'),
      { timeout: 5000, timeoutMsg: 'Spread image failed to load' }
    );

    // Enable spread mode RTL via menubar
    await menubarPage.selectSpreadMode('rtl');

    // Fit width to activate spread splitting
    await browser.keys([Key.Shift, 'Q']);

    // Statusbar spread indicator should activate
    await browser.waitUntil(
      async () => {
        const spreadText = await statusbarPage.spread.getText();
        return spreadText.includes('Spread');
      },
      { timeout: 5000, timeoutMsg: 'Spread indicator did not activate' }
    );

    // Disable spread mode
    await menubarPage.selectSpreadMode('off');
  });
});
