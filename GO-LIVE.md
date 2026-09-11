# Go live on Render FREE ($0/mo, laptop can stay off)

You do this **once**. After that, every push to `main` redeploys both backend (Render) and frontend (GitHub Pages) automatically.

## 1. Create the Render backend (5 min)

1. Push these fixes to `main` (already done in this commit: `render.yaml`, `DATA_DIR` support, startup-log crash fix).
2. Go to https://dashboard.render.com → **New +** → **Blueprint** → connect/select this repo (`SuperApp`).
3. Render detects `render.yaml` → service name `superapp-server` → click **Apply**.
   - Plan `free` ($0), 1 instance (required for socket.io + SQLite).
   - `buildCommand: npm ci`, `startCommand: npm start`, health check `/api/health`.
   - `JWT_SECRET` is auto-generated. Do not change it afterwards (would log everyone out).
4. While it builds, open the service → **Environment** → set:
   - `CLIENT_URL` = `https://deepak0kr0mishra.github.io` (your Pages origin; comma-separated list allowed, e.g. `https://deepak0kr0mishra.github.io,http://localhost:5173`)
   - Do NOT add a disk or `DATA_DIR` — free plan has no disks, app uses ephemeral `./data`.
5. Wait for **Live**. Quick check in browser:
   `https://<your-service>.onrender.com/api/health` → `{"status":"ok",...}`.
   Copy that base URL, e.g. `https://superapp-server-xxxx.onrender.com`.

> Free limits ($0 total): sleeps after ~15 min idle — first request takes 30–50 s, wait + reload. No disk, so SQLite + uploads are wiped on every deploy/restart. For demo use this is fine; upgrade to `starter` + disk later if you need persistence.

## 2. Point the site at it (the one and only paste, no commit needed)

1. On GitHub: repo → **Settings → Secrets and variables → Actions → Variables** → **New repository variable**:
   - Name: `VITE_SERVER_URL`
   - Value: your Render URL from step 1.5 (no trailing `/api`, no trailing slash).
2. Repo → **Actions → Deploy client to GitHub Pages → Run workflow** (or push any commit to `main`).
3. Open `https://deepak0kr0mishra.github.io/SuperApp/` → sign up, send a message, reload.

Fallback (no variables): paste the URL into `LIVE_BACKEND_URL` in `client/src/config.js`, commit + push.

## 3. Daily use

- Laptop off? Fine. Render runs the backend.
- First load slow? It's the free cold start — wait ~40 s and reload.
- Never rotate `JWT_SECRET` unless you want to force-logout everyone.
- Logs: Render dashboard → service → **Logs**.
- Old Codespaces flow is retired — you can delete the old codespace.
