// ─── THE ONLY URL YOU EVER SET (once) ─────────────────────────────
// Your public backend URL on Render, e.g. https://superapp-server.onrender.com.
// Preferred way: set it as a GitHub repo variable (no commit needed):
//   Settings → Secrets and variables → Actions → Variables → New:
//   VITE_SERVER_URL = https://superapp-server.onrender.com
// Then re-run the "Deploy client to GitHub Pages" workflow.
// Fallback: paste it into LIVE_BACKEND_URL below and push.
//
// Local development ignores this and uses localhost like before.
const LIVE_BACKEND_URL = 'https://superapp-server.onrender.com';

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
