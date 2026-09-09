// ─── THE ONLY URL YOU EVER SET (once) ─────────────────────────────
// Your public backend URL (the forwarded port-3001 URL of your cloud
// backend, e.g. https://<name>-3001.app.github.dev). Paste it once,
// commit, push — every Pages deploy after that just works.
//
// Local development ignores this and uses localhost like before.
const LIVE_BACKEND_URL = 'https://PASTE-YOUR-BACKEND-URL-HERE';

const onLocalhost =
  typeof window !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

export const BACKEND_URL =
  import.meta.env.VITE_SERVER_URL ||
  (onLocalhost ? 'http://localhost:3001' : LIVE_BACKEND_URL);

export const API_URL =
  import.meta.env.VITE_API_URL ||
  (onLocalhost ? '/api' : `${BACKEND_URL}/api`);

// False on the live site until a real URL is pasted above.
export const LIVE_BACKEND_CONFIGURED =
  onLocalhost || !/PASTE-YOUR/.test(BACKEND_URL);
