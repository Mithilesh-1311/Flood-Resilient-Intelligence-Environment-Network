# Deploying FRiEND

- **Backend** (the controller): Hugging Face Spaces, Docker, free tier.
- **Frontend** (the dashboard): Vercel.

Deploy the backend first. The frontend needs its URL at build time.

---

## Why these hosts

The controller is a long-running process. It runs a 2-second background loop,
holds WebSockets open, keeps all state in memory, and loads TensorFlow (about
1 GB of RAM). Serverless platforms (Vercel Functions, Netlify, Lambda) stop the
loop between requests and can't keep sockets open, so they can't run it.

Hugging Face Spaces runs a real container, free: 2 vCPU and 16 GB RAM, with
WebSockets and HTTPS included. Render's free tier has 512 MB, which TensorFlow
would exceed. The same Docker image also runs unchanged on Render (paid),
Railway, Fly.io or Cloud Run, because `serve.py` listens on `$PORT`.

Vercel serves the dashboard as a static site. It can't proxy WebSockets, so the
browser connects straight to the Space over `wss://`. That's why the frontend
needs `VITE_CONTROLLER_URL`.

> **A hosted backend always runs the simulation.** The physical gateway
> (`192.168.4.1`) only exists on the ESP32-CAM's own Wi-Fi, and a cloud server
> can't reach it. The dashboard shows `SIMULATION` for the deployed site.
> For the hardware demo, see the section at the end.

---

## 1. Backend → Hugging Face Space

You need a Hugging Face account and an access token with **Write** permission
(huggingface.co → Settings → Access Tokens → Create new token → Write).

From `friend/PROJECT` in PowerShell:

```powershell
.venv\Scripts\python deploy\publish_backend.py --push <your-hf-username>/friend-controller
```

The first time, it asks for the token. The script then:

1. copies the current `nc1.py`, `flood_ai.py`, `simulate_hardware.py`, the model
   and its preprocessing parameters into `deploy/hf-space/`
2. creates a **public** Docker Space (it has to be public, because visitors'
   browsers can't send a token to a private Space)
3. uploads everything and prints the API URL, which looks like
   `https://<your-hf-username>-friend-controller.hf.space`

The first build installs TensorFlow and takes about 3–6 minutes. Watch it on
the Space page. When it shows **Running**, check it:

```powershell
curl https://<your-hf-username>-friend-controller.hf.space/healthz
# {"status":"ok","cycle":...}
```

Opening the Space URL in a browser shows a short JSON description. That's
expected: it's an API, not a page. The flood model takes about a minute after
startup to collect its first 9-step window. Until then, the dashboard shows
"Filling model window".

**To update the backend later**, run the same command again. It re-copies the
source files, so the Space never runs a stale copy.

---

## 2. Frontend → Vercel

You need a Vercel account (the free Hobby plan is enough).

### Option A: Vercel CLI (quickest, no GitHub needed)

From `friend/PROJECT/frontend`:

```powershell
npx vercel login
npx vercel                 # first run: accept the defaults and link a new project
npx vercel env add VITE_CONTROLLER_URL production
#   paste: https://<your-hf-username>-friend-controller.hf.space
#   (no trailing slash needed; one is stripped if you add it)
npx vercel --prod
```

The last command prints your production URL.

### Option B: GitHub + Vercel dashboard

1. Push `friend/PROJECT` to a GitHub repository. The included `.gitignore`
   keeps `.venv/` and `node_modules/` out.
2. On vercel.com: **Add New → Project →** import the repository.
3. Set **Root Directory** to `frontend`. Vercel detects Vite, and
   `frontend/vercel.json` supplies the build settings.
4. Under **Environment Variables**, add `VITE_CONTROLLER_URL` with the Space
   URL, for **Production** (and Preview, if you want previews to work).
5. Deploy. After this, every push to the main branch redeploys automatically.

### What `frontend/vercel.json` does

- builds with `npm ci` and `npm run build`, and serves `dist/`
- rewrites every path to `index.html`, so reloading `/analytics` or opening a
  shared link to `/network` loads the app instead of a 404
- caches the hashed `/assets/*` files long-term

> `VITE_CONTROLLER_URL` is baked in **at build time**. If you change it, you
> have to redeploy (`npx vercel --prod`, or **Redeploy** in the dashboard).
> Changing the setting alone does nothing to the live site.

---

## 3. Check the deployment

Open the Vercel URL. Within a few seconds you should see:

- the connection indicator at **LIVE**, with the frame count going up
- the header tag showing **SIMULATION**
- mesh topology with three coloured routes, and reroutes appearing in the
  Alert Centre
- after about a minute: flood probability and the forecast band for S1–S3

If the page says **Controller unreachable**, open the Space page. If the Space
is asleep or still building, the dashboard reconnects on its own once it's
running.

Every visitor sees the **same** shared simulation, because there's one
controller. Chart history, however, is kept per browser, so each visitor's
charts start when their page opens.

---

## 4. Demo day checklist

- [ ] About 5 minutes before judging, open the Space page. Free Spaces sleep
      after 48 hours without traffic, and waking one takes a minute or two.
- [ ] Load the Vercel URL and wait for **LIVE** and for flood probabilities to
      appear.
- [ ] Use **RESET MESH HEALTH** (in the sidebar) to start the self-healing
      story from a clean state.
- [ ] Keep the Space page open in a tab. Its **Logs** tab shows the controller
      printing each routing decision, which is useful if a judge asks what's
      running.

### Things to know

- **The reset button is public.** Anyone with the dashboard URL can reset mesh
  health. That's harmless for a simulation, but don't give this URL out as a
  real control surface.
- **Sleep and restarts clear state.** The controller keeps everything in
  memory, so after a restart it starts again from cycle 0. Open dashboards
  reconnect automatically.

---

## 5. The live hardware demo (at the venue)

With the physical nodes, the controller has to run on the laptop that has
joined the `SIH-GATEWAY` Wi-Fi. No cloud server can reach `192.168.4.1`.

```powershell
# terminal 1: friend/PROJECT/HARDWARE
..\.venv\Scripts\python nc1.py

# terminal 2: friend/PROJECT/frontend
npm run dev          # open http://127.0.0.1:5173
```

The dashboard shows **LIVE HARDWARE** instead of **SIMULATION**, and the laptop
is running exactly the same frontend and controller code.

Don't point the Vercel site at the laptop. The Vercel page is HTTPS and the
laptop controller is plain HTTP on a local network, and browsers block that
combination (mixed content and private-network rules). Serve the dashboard
locally for the hardware demo, and keep the Vercel site for the simulation.

---

## What was verified before this was handed over

Checked on this machine:

- The Space's exact entrypoint (`deploy/hf-space/HARDWARE/serve.py`) and file
  layout run the full stack: controller, simulator and GRU inference.
- A production build pointed at a controller on a **different origin** passes
  all 23 checks in `frontend/verify.mjs`. That includes a single WebSocket going
  directly to the controller origin, CORS for a foreign origin including the
  `POST /reset_health` preflight, deep links, live updates, reroutes, and the
  health reset reaching the controller.
- Every pinned dependency in `deploy/hf-space/requirements.txt` resolves to a
  Linux wheel for CPython 3.11 (48 wheels, no CUDA). `tensorflow-cpu 2.21.0`
  uses a `manylinux_2_27` wheel, which the image's glibc 2.36 accepts.

Not checked here: the Docker image itself was never built, because Docker isn't
installed on this machine, and the actual Hugging Face and Vercel deployments
need your accounts. The first real build on Hugging Face is the remaining step.
If it fails, the Space's **Logs** tab shows why.
