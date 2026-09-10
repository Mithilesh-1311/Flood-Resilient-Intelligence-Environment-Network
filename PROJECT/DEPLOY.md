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

> **A hosted backend can't reach the physical gateway.** `192.168.4.1` only
> exists on the ESP32-CAM's own Wi-Fi. So by default the Space **replays real
> river-gauge data** from the project's held-out test set through a
> **simulated mesh**, and the dashboard says exactly that: `REAL GAUGE REPLAY`
> and `SIMULATED MESH`. See "Real gauge data" below. For the hardware demo, see
> the section at the end.

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
expected: it's an API, not a page. `"telemetry": "replay"` confirms it's
serving real gauge data. The model takes about 10 seconds to load after
startup. Replayed rows arrive with their input window already built, so
predictions start as soon as it loads.

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
- the header tags showing **REAL GAUGE REPLAY** and **SIMULATED MESH**
- a strip naming each gauge (Scalehill, Low Briery, Boscastle) and the real
  timestamp being replayed
- mesh topology with three coloured routes, and reroutes appearing in the
  Alert Centre
- flood probability and the forecast band for S1–S3, and on **FLOOD AI** a
  "What actually happened" box plus the live replay scorecard

If the page says **Controller unreachable**, open the Space page. If the Space
is asleep or still building, the dashboard reconnects on its own once it's
running.

Every visitor sees the **same** shared simulation, because there's one
controller. Chart history, however, is kept per browser, so each visitor's
charts start when their page opens.

---

## Real gauge data (the default)

The controller has two stand-ins for field hardware. `FRIEND_TELEMETRY` picks
one:

| `FRIEND_TELEMETRY` | River readings | Mesh network |
| --- | --- | --- |
| `replay` (default) | **Real** 15-min rows from `ALL_STATIONS_labelled.csv` | simulated |
| `simulated` | random walk (`simulate_hardware.py`) | simulated |

To switch modes on the Space, go to **Settings → Variables and secrets → New
variable**, set `FRIEND_TELEMETRY=simulated`, and restart the Space. If the
replay file is ever missing, the Space falls back to `simulated` on its own and
reports that at `GET /`.

**What gets replayed.** `build_replay.py` runs the training pipeline's own
functions (`split_data`, `fit_train_only`, `transform_scale`) over the labelled
CSV. It keeps windows around every real flood (12 h run-up, the flood, 6 h
recession) and writes `flood_dataset/replay_test.csv` (6,140 rows, 1.7 MB). It
then checks every row's model inputs and labels against `test.npz` /
`train.npz`: **0 mismatches**. The 229 MB CSV never leaves your machine; only
the replay file is uploaded.

| Node | Gauge | Rows replayed |
| --- | --- | --- |
| S1 | Scalehill, River Cocker | 2023–24 **test**: never seen in training |
| S2 | Low Briery, River Greta | 2015–20 **training** (the record has no 2021–24 data) |
| S3 | Boscastle, River Valency | 2023–24 **test**: never seen in training |

S2 is labelled `TRAINING DATA · SEEN` on screen and is kept out of the
scorecard's held-out total.

**Things to say if asked:**

- Each 15-minute row plays for 6 seconds (a 150× speed-up), and the forecasts
  are still +30 real minutes ahead.
- The replay jumps between flood windows, so the level trace steps at each
  jump. The timeline notes every jump.
- Floods are far more common in the replay than in a real year, because it was
  chosen that way. The live scorecard shows behaviour on real data; the offline
  **MODEL EVALUATION** panel is still the measure of skill.

If the model or the dataset changes, rebuild the replay file and republish:

```powershell
.venv\Scripts\python build_replay.py
.venv\Scripts\python deploy\publish_backend.py --push <your-hf-username>/friend-controller
```

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
