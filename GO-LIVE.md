# Go live (no new signups, laptop can stay off)

You do this **once**. After that, every push to `main` redeploys the site automatically.

## 1. Start the cloud backend (2 min)
1. On GitHub, open this repo → **Code** → **Codespaces** → **Create codespace on main**.
2. Wait until the terminal shows the health check: `{"status":"ok",...}` (the server starts itself; logs: `/tmp/nebula-server.log`).
3. Open the **PORTS** tab (next to Terminal) → right-click port **3001** → **Port Visibility → Public**.
4. Copy the forwarded URL for port 3001 — it looks like `https://<name>-3001.app.github.dev`.
5. Quick check: open `https://<name>-3001.app.github.dev/api/health` in a browser → you should see `{"status":"ok"}`.

## 2. Point the site at it (the one and only paste)
1. In the codespace (or locally), open `client/src/config.js` and replace `https://PASTE-YOUR-BACKEND-URL-HERE` with your URL from step 1.4.
2. Commit + push (from the codespace terminal, already logged in):
   `git add client/src/config.js && git commit -m "chore: set live backend URL" && git push origin main`
3. Wait for the **Deploy client to GitHub Pages** action to finish → open `https://deepak0kr0mishra.github.io/SuperApp/`.

## 3. Daily use
- **Laptop off? Fine.** The backend runs in the cloud.
- If chat stops responding, the codespace likely auto-stopped (idles out after ~30 min). Restart it from github.com → **Codespaces** (works from your phone) — **the URL stays the same** as long as you restart the same codespace instead of deleting it.
- Never delete the codespace unless you want to redo step 2 (URL changes on recreate).
- Free quota: ~60 cloud hours/month on a free GitHub account — plenty for a hobby project; stopped codespaces use no hours.
