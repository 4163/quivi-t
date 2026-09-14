export { Key } from 'webdriverio';
import { Key } from 'webdriverio';

export async function press(keys) {
  if (Array.isArray(keys)) {
    await browser.keys(keys);
  } else {
    await browser.keys([keys]);
  }
}

export async function shortcut(modifier, key) {
  await browser.keys([modifier, key, modifier]);
}

export async function ctrl(key) {
  await browser.keys([Key.Control, key, Key.Control]);
}

export async function shift(key) {
  await browser.keys([Key.Shift, key, Key.Shift]);
}

export async function alt(key) {
  await browser.keys([Key.Alt, key, Key.Alt]);
}
