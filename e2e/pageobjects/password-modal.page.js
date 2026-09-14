import Page from './page.js';

class PasswordModalPage extends Page {
  get overlay() { return $('#password-overlay'); }
  get form() { return $('#password-overlay form.password-prompt'); }
  get passwordInput() { return $('#password-input'); }
  get submitBtn() { return $('#password-overlay button[type="submit"]'); }
  get errorMessage() { return $('#password-overlay .password-error'); }

  async isVisible() {
    const el = await this.overlay;
    if (!(await el.isExisting())) return false;
    const classes = await el.getAttribute('class');
    return classes.includes('active') && (await el.isDisplayed());
  }

  async enterPassword(password) {
    await this.passwordInput.waitForDisplayed();
    await this.passwordInput.setValue(password);
  }

  async submit() {
    await this.submitBtn.click();
  }

  async unlockWith(password) {
    await this.enterPassword(password);
    await this.submit();
  }

  async getError() {
    return this.errorMessage.getText();
  }
}

export default new PasswordModalPage();
