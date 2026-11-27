import { expect } from 'expect-webdriverio';
import menubarPage from '../pageobjects/menubar.page.js';
import optionsPage from '../pageobjects/options.page.js';

describe('06 - Options & Configuration Window', () => {
  before(async () => {
    await menubarPage.ensureMainWindow();
  });

  it('opens Options window and navigates across configuration tabs', async () => {
    // Open Options window via helper
    await optionsPage.openOptions();

    // Switch to Options window
    await optionsPage.switchToOptionsWindow();
    expect(await browser.getTitle()).toContain('Options');

    // General tab should be active by default
    await expect(optionsPage.tabGeneral).toHaveElementClass('active');
    await expect(optionsPage.optShowHidden).toBeDisplayed();
    await expect(optionsPage.optContinueLast).toBeDisplayed();

    // Navigate to Keys tab
    await optionsPage.selectTab('tab-keys');
    await expect(optionsPage.tabKeys).toHaveElementClass('active');

    // Navigate to File Types (Associations) tab
    await optionsPage.selectTab('tab-associations');
    await expect(optionsPage.tabAssociations).toHaveElementClass('active');

    // Navigate to Customization tab
    await optionsPage.selectTab('tab-customization');
    await expect(optionsPage.tabCustomization).toHaveElementClass('active');
    await expect(optionsPage.customCssTextarea).toBeDisplayed();

    // Navigate to Language tab
    await optionsPage.selectTab('tab-language');
    await expect(optionsPage.tabLanguage).toHaveElementClass('active');
  });

  it('swaps themes live and saves configuration', async () => {
    // Ensure Options window is open and focused
    const handles = await browser.getWindowHandles();
    if (handles.length === 1) {
      await optionsPage.openOptions();
      await optionsPage.switchToOptionsWindow();
    }

    // Switch to Customization tab
    await optionsPage.selectTab('tab-customization');

    // Select dark theme
    await optionsPage.selectTheme('dark');
    await browser.waitUntil(
      async () => {
        const theme = await browser.execute(() => document.documentElement.dataset.theme);
        return theme === 'dark';
      },
      { timeout: 3000, timeoutMsg: 'Document dataset.theme did not switch to dark' }
    );

    // Select light theme
    await optionsPage.selectTheme('light');
    await browser.waitUntil(
      async () => {
        const theme = await browser.execute(() => document.documentElement.dataset.theme);
        return theme === 'light';
      },
      { timeout: 3000, timeoutMsg: 'Document dataset.theme did not switch to light' }
    );

    // Click Save
    await optionsPage.save();

    await browser.waitUntil(
      async () => {
        const text = await optionsPage.statusMessage.getText();
        return text.toLowerCase().includes('saved');
      },
      { timeout: 6000, timeoutMsg: 'Save options did not report success' }
    );

    // Close Options window
    await optionsPage.close();

    // Wait for the Options window handle to disappear
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 1,
      { timeout: 6000, timeoutMsg: 'Options window handle remained open after close' }
    );

    // Switch back to main window
    await menubarPage.ensureMainWindow();

    // Main window should have received the theme update
    await browser.waitUntil(
      async () => {
        const mainTheme = await browser.execute(() => document.documentElement.dataset.theme);
        return mainTheme === 'light';
      },
      { timeout: 5000, timeoutMsg: 'Main window did not synchronize theme' }
    );
  });

  it('applies custom CSS without CSP violations across live save and reload', async () => {
    const probeRule = ':root { --quivit-csp-probe: 42; }';

    const saveCustomCssInOptions = async (cssText) => {
      const handles = await browser.getWindowHandles();
      if (handles.length === 1) {
        await optionsPage.openOptions();
      }
      await optionsPage.switchToOptionsWindow();
      await optionsPage.selectTab('tab-customization');
      await optionsPage.customCssTextarea.waitForDisplayed({ timeout: 5000 });

      await browser.execute((value) => {
        const textarea = document.getElementById('opt-custom-css');
        if (!textarea) throw new Error('#opt-custom-css not found');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }, cssText);

      await optionsPage.save();
      await browser.waitUntil(
        async () => {
          const text = await optionsPage.statusMessage.getText();
          return text.toLowerCase().includes('saved');
        },
        { timeout: 6000, timeoutMsg: 'Save options did not report success' }
      );

      await optionsPage.close();
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length === 1,
        { timeout: 6000, timeoutMsg: 'Options window handle remained open after close' }
      );
      await menubarPage.ensureMainWindow();
    };

    await menubarPage.ensureMainWindow();
    await browser.execute(() => {
      window.__quivitCspViolations = [];
      if (!window.__quivitCspListenerAttached) {
        window.__quivitCspListenerAttached = true;
        window.addEventListener('securitypolicyviolation', (e) => {
          window.__quivitCspViolations.push({
            violatedDirective: e.violatedDirective,
            effectiveDirective: e.effectiveDirective,
            blockedURI: e.blockedURI,
          });
        });
      }
    });

    try {
      await saveCustomCssInOptions(probeRule);

      // Verify theme.js applyCustomCss applied the custom CSS on main without CSP blocking
      await browser.waitUntil(
        async () => {
          const val = await browser.execute(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--quivit-csp-probe')
              .trim()
          );
          return val === '42';
        },
        { timeout: 5000, timeoutMsg: 'Custom CSS probe variable was not applied on main window' }
      );

      const storedCss = await browser.execute(() => localStorage.getItem('quivit-custom-css') || '');
      expect(storedCss).toContain('--quivit-csp-probe');

      const liveViolations = await browser.execute(() => window.__quivitCspViolations || []);
      expect(liveViolations).toEqual([]);

      // Reload main window to exercise themePrePaint.js inline style injection on startup
      await browser.refresh();
      await menubarPage.menubar.waitForDisplayed({ timeout: 8000 });

      await browser.waitUntil(
        async () => {
          const val = await browser.execute(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--quivit-csp-probe')
              .trim()
          );
          return val === '42';
        },
        { timeout: 5000, timeoutMsg: 'Custom CSS probe variable was not applied after reload' }
      );

      // Verify dynamic inline <style> application triggers zero CSP violations
      const dynamicResult = await browser.execute(async () => {
        const violations = [];
        const onViolation = (e) => {
          violations.push({
            violatedDirective: e.violatedDirective,
            effectiveDirective: e.effectiveDirective,
            blockedURI: e.blockedURI,
          });
        };
        window.addEventListener('securitypolicyviolation', onViolation);
        const style = document.createElement('style');
        style.id = 'quivit-csp-probe-dynamic';
        style.textContent = ':root { --quivit-csp-probe-dynamic: 99; }';
        document.head.appendChild(style);
        const value = getComputedStyle(document.documentElement)
          .getPropertyValue('--quivit-csp-probe-dynamic')
          .trim();
        await new Promise((resolve) => setTimeout(resolve, 50));
        style.remove();
        window.removeEventListener('securitypolicyviolation', onViolation);
        return { value, violations };
      });
      expect(dynamicResult.value).toBe('99');
      expect(dynamicResult.violations).toEqual([]);
    } finally {
      await saveCustomCssInOptions('');
      await browser.waitUntil(
        async () => {
          const val = await browser.execute(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--quivit-csp-probe')
              .trim()
          );
          return val === '';
        },
        { timeout: 5000, timeoutMsg: 'Custom CSS probe variable was not cleared after cleanup' }
      );
    }
  });
});
