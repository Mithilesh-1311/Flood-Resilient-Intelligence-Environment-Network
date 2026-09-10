/**
 * End-to-end verification against the REAL controller.
 *
 * Drives the dashboard in a real browser while simulate_hardware.py is running,
 * and checks the things that actually matter for this project: that the socket
 * connects, that values move, that the chart history grows instead of resetting,
 * that every module renders, that missing data shows as a dash, and that the
 * operator action reaches the controller.
 *
 *   node verify.mjs [baseURL]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const SHOTS = "verify-shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail) => (cond ? pass(name, detail) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Navigate the way a user does - by clicking the nav rail - NOT with page.goto.
 * A full reload would tear down the WebSocket and discard the client-side
 * rolling history and event log, which is precisely what we are trying to
 * verify survives navigation.
 */
async function navigate(page, label, heading) {
  await page.getByRole("link", { name: label }).click();
  await page.waitForSelector(`h1:has-text("${heading}")`, { timeout: 12000 });
}

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
const page = await ctx.newPage();

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

// Every WebSocket the page opens, observed from the browser side. In a deployed
// build these must go straight to the controller's origin, not the page's.
const sockets = [];
page.on("websocket", (ws) => sockets.push(ws));

try {
  /* ---------------------------------------------------- 1. boot + socket */
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=FRiEND", { timeout: 20000 });
  pass("Dashboard loads");

  // The connection indicator must reach LIVE, which only happens on a real frame.
  await page.waitForFunction(
    () => document.body.innerText.includes("LIVE") && !document.body.innerText.includes("Initialising"),
    { timeout: 25000 },
  );
  pass("WebSocket reaches LIVE");

  // Exactly one OPEN socket for the whole app. (A dev build under StrictMode
  // opens and immediately closes one extra, so count the live ones.) Vite's
  // own hot-reload socket (`/?token=...`, dev server only) is not the app's.
  const isViteHmr = (url) => /\/\?token=/.test(url);
  const open = sockets.filter((ws) => !ws.isClosed() && !isViteHmr(ws.url()));
  check(open.length === 1, "Single WebSocket", open.map((ws) => ws.url()).join(", ") || "none open");

  /* ------------------------------------------------ 2. live values move */
  const readMetric = () =>
    page.evaluate(() => {
      const t = document.body.innerText;
      return t.slice(0, 4000);
    });

  const snap1 = await readMetric();
  await sleep(7000);
  const snap2 = await readMetric();
  check(snap1 !== snap2, "Live values change between frames");

  /* ------------------------------------------- 3. chart history grows */
  const pathLen = () =>
    page.evaluate(() => {
      const paths = [...document.querySelectorAll("svg .recharts-line-curve")];
      return paths.reduce((max, p) => {
        const d = p.getAttribute("d") ?? "";
        return Math.max(max, d.split(/[ML]/).length);
      }, 0);
    });

  const pts1 = await pathLen();
  await sleep(10000);
  const pts2 = await pathLen();
  check(pts2 > pts1, "Chart history grows (does not reset)", `${pts1} -> ${pts2} points`);

  await page.screenshot({ path: `${SHOTS}/01-overview.png`, fullPage: true });

  /* ------------------------------------------------ 4. every module renders */
  const modules = [
    ["/network", "Network topology", "NETWORK"],
    ["/flood-ai", "Flood-Risk AI", "FLOOD AI"],
    ["/sensors", "Sensor monitoring", "SENSORS"],
    ["/routing", "Routing", "ROUTING"],
    ["/health", "Node health", "NODE HEALTH"],
    ["/analytics", "Analytics & diagnostics", "ANALYTICS"],
  ];
  let i = 2;
  for (const [path, heading, navLabel] of modules) {
    try {
      await navigate(page, navLabel, heading);
      // Give the module one controller frame so its panels populate.
      await sleep(2500);
      const shot = `${SHOTS}/${String(i).padStart(2, "0")}-${path.slice(1)}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      pass(`Module renders: ${path}`);
    } catch (e) {
      fail(`Module renders: ${path}`, String(e).slice(0, 160));
    }
    i += 1;
  }

  // History must survive navigation, since it lives in the store, not the page.
  await navigate(page, "OVERVIEW", "Command centre");
  await sleep(1500);
  const ptsAfterNav = await pathLen();
  check(ptsAfterNav >= pts2, "Chart history survives module navigation", `${pts2} -> ${ptsAfterNav} points`);

  /* --------------------------------------- 5. missing data shows as a dash */
  await navigate(page, "ANALYTICS", "Analytics & diagnostics");
  await sleep(2500);
  const matrixInfo = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("table td")];
    const dashes = cells.filter((c) => c.textContent.trim() === "—").length;
    const zeros = cells.filter((c) => c.textContent.trim() === "0.0%" || c.textContent.trim() === "0").length;
    return { dashes, zeros, total: cells.length };
  });
  check(
    matrixInfo.dashes > 0,
    "Unmeasured links render as a dash",
    `${matrixInfo.dashes} dash cells of ${matrixInfo.total}`,
  );

  // The gateway row/column is never measured by any firmware, so it must be empty.
  const gatewayEmpty = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tr")];
    const gRow = rows.find((r) => r.querySelector("th")?.textContent.trim() === "G");
    if (!gRow) return null;
    return [...gRow.querySelectorAll("td")].every((c) => {
      const t = c.textContent.trim();
      return t === "—" || t === "·";
    });
  });
  check(gatewayEmpty !== false, "Gateway PDR row is honestly empty", "row all dashes: " + gatewayEmpty);

  /* ------------------------------------------- 6. sensor selection works */
  await navigate(page, "SENSORS", "Sensor monitoring");
  await sleep(2000);
  const before = await page.evaluate(() =>
    [...document.querySelectorAll("h2")].map((h) => h.innerText.trim()).join(" | "),
  );
  // Address the chip by position inside its labelled group: the status word
  // in each chip (SCORED / WARMING / NO DATA) is live data, so matching on the
  // full accessible name would be flaky by design.
  await page.locator('[aria-label="Select source node"] button').nth(2).click();
  await sleep(1500);
  // Panel titles are CSS-uppercased, and innerText reflects text-transform,
  // so compare case-insensitively rather than against the authored casing.
  const selectedS3 = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes("water level · s3") || t.includes("current conditions · s3");
  });
  check(selectedS3, "Sensor selection changes chart context", "was: " + String(before).slice(0, 60));
  await page.screenshot({ path: `${SHOTS}/08-sensors-S3.png`, fullPage: true });

  /* ------------------------------------------ 7. reset health round-trip */
  const healthBefore = await fetch("http://127.0.0.1:8000/state").then((r) => r.json());
  await page.getByRole("button", { name: /RESET MESH HEALTH/i }).click();
  await sleep(400);
  await page.screenshot({ path: `${SHOTS}/09-reset-confirm.png` });
  await page.getByRole("button", { name: /^CONFIRM$/ }).click();
  await sleep(1200);
  const acked = await page.evaluate(() => document.body.innerText.includes("HEALTH RESET"));
  check(acked, "Reset health acknowledges in UI");

  // nc1 applies the reset to MANUAL_HEALTH at once but only publishes it on the
  // next control cycle, and every cycle drains the relays its routes use - so a
  // normal frame always has at least two mesh nodes below 100. All seven at 100
  // is therefore the reset's own signature. Poll for it across a couple of
  // cycles instead of reading one frame at an arbitrary moment: an earlier
  // version did that, checked for ANY node at 100, and passed on a frame the
  // reset had not reached yet.
  const meshBefore = healthBefore.node_health.slice(3, 10);
  let resetSeen = null;
  for (let i = 0; i < 30 && !resetSeen; i += 1) {
    const s = await fetch("http://127.0.0.1:8000/state").then((r) => r.json());
    const mesh = s.node_health.slice(3, 10);
    if (mesh.every((h) => h === 100)) resetSeen = { cycle: s.system?.cycle };
    else await sleep(250);
  }
  check(
    !!resetSeen && !meshBefore.every((h) => h === 100),
    "Reset health reached the controller",
    `mesh before ${meshBefore}` +
      (resetSeen ? ` -> all 100 at cycle ${resetSeen.cycle}` : " -> never all 100 within 7.5 s"),
  );

  /* ------------------------------------ 8. events came from state changes */
  await navigate(page, "OVERVIEW", "Command centre");
  await sleep(6000);
  const rail = await page.evaluate(() => document.body.innerText);
  const eventCount = (rail.match(/Route recomputed for S[123]/g) ?? []).length;
  const healthEvents = (rail.match(/health (degraded|recovered|critical)/gi) ?? []).length;
  check(
    eventCount > 0 || healthEvents > 0,
    "Events derived from real state transitions",
    eventCount + " reroute + " + healthEvents + " health events in the rail",
  );
  await page.screenshot({ path: `${SHOTS}/10-overview-events.png`, fullPage: true });

  // The reroute log on the Routing module shows old -> new paths.
  await navigate(page, "ROUTING", "Routing");
  await sleep(2500);
  const logged = await page.evaluate(() =>
    (document.body.innerText.match(/S[123](\s*→\s*M\d)+\s*→\s*G/g) ?? []).length,
  );
  check(logged > 0, "Reroute log shows concrete old/new paths", logged + " path lines");
  await page.screenshot({ path: `${SHOTS}/11-routing.png`, fullPage: true });

  /* -------------------------------- 9. disconnect handling (stop backend) */
  // Simulated by pointing the page at a dead socket is intrusive; instead check
  // the indicator exposes a distinct state machine at all.
  const indicatorStates = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="status"]')].map((n) => n.getAttribute("aria-label"));
    return el;
  });
  check(
    indicatorStates.some((s) => s && /Controller link/.test(s)),
    "Connection indicator exposes link state to assistive tech",
    JSON.stringify(indicatorStates.slice(0, 2)),
  );

  /* --------------------- 9b. real-data replay (only when the controller runs it) */
  const st = await fetch("http://127.0.0.1:8000/state").then((r) => r.json());
  if (st.flood_ai?.source === "replay") {
    await navigate(page, "FLOOD AI", "Flood-Risk AI");
    await sleep(3000);
    const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    check(text.includes("real gauge replay"), "Replay is labelled as real gauge data");
    check(
      text.includes("what actually happened"),
      "Prediction shown next to the real outcome",
    );
    check(text.includes("replay scorecard"), "Live replay scorecard rendered");
    check(
      text.includes("inputs verified"),
      "Input parity with the model's arrays is disclosed",
    );
    const sc = st.flood_ai.replay?.scorecard;
    check(
      !!sc && Object.keys(sc.per_node ?? {}).length > 0,
      "Controller is scoring real rows",
      sc ? JSON.stringify(sc.per_node) : "no scorecard",
    );
    const trained = Object.entries(sc?.per_node ?? {}).filter(([, s]) => s.held_out === false).map(([n]) => n);
    check(
      trained.every((n) => !(sc.total_nodes ?? []).includes(n)),
      "Training-split rows kept out of the held-out total",
      "excluded: " + (trained.join(", ") || "none"),
    );
    await page.screenshot({ path: `${SHOTS}/12-flood-ai-replay.png`, fullPage: true });
  }

  /* ------------------------------- 10. deep links load directly (SPA host) */
  // On Vercel this is what the rewrite in vercel.json guarantees: a refresh or
  // a shared link to /analytics must serve the app, not a 404.
  try {
    await page.goto(BASE + "/analytics", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('h1:has-text("Analytics")', { timeout: 20000 });
    pass("Deep link loads directly", BASE + "/analytics");
  } catch (e) {
    fail("Deep link loads directly", String(e).slice(0, 160));
  }

  /* --------------------------------------------------- 11. no runtime errors */
  const ignorable = (t) =>
    /favicon|Download the React DevTools|ResizeObserver loop/i.test(t);
  const realConsole = consoleErrors.filter((t) => !ignorable(t));
  check(pageErrors.length === 0, "No uncaught page errors", pageErrors.slice(0, 3).join(" | "));
  check(realConsole.length === 0, "No console errors", realConsole.slice(0, 3).join(" | "));
} catch (err) {
  fail("Harness", String(err).slice(0, 400));
} finally {
  await browser.close();
}

const okCount = results.filter((r) => r.ok).length;
const lines = results.map(
  (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`,
);
const report = lines.join("\n") + `\n\n${okCount}/${results.length} checks passed\n`;
writeFileSync("verify-report.txt", report);
console.log(report);
process.exit(okCount === results.length ? 0 : 1);
