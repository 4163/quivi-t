/**
 * Shared clipboard helper.
 *
 * Provides a safe, isolated wrapper around the asynchronous Clipboard API.
 */

/**
 * Copies plain text to the system clipboard.
 * Returns true if successful, false otherwise.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
  if (!text || typeof text !== 'string') return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[Clipboard] Failed to copy text:', err);
  }
  return false;
}
