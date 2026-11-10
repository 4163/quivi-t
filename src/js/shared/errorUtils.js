export function formatIpcError(err, fallback = 'An error occurred') {
  if (typeof err === 'string' && err) return err;
  if (typeof err?.message === 'string' && err.message) return err.message;
  return fallback;
}
