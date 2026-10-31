/**
 * A one-page dashboard for live demos. Each button runs a real bootguard boot
 * against your model server and shows the result: checks, the refusal report,
 * the ghost report, and the agent's output. No dependencies (node:http).
 *
 *   npm run -s dashboard            then open http://localhost:8080
 *   FAKE_MODEL=1 npm run -s dashboard   (offline, built-in fake model server)
 */
import http from "node:http";
import { createBoot, type BootStatus } from "../src/index.ts";
import { ghostReport, modelCheck, type Capability } from "../src/ai.ts";
import { startFakeModelServer } from "./fake-model-server.ts";

const read = (k: string): string | undefined =>
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno?.env.get(k) ?? (globalThis as any).process?.env[k];

const fake = read("FAKE_MODEL") ? await startFakeModelServer({ tools: false }) : undefined;
const BASE_URL = fake?.baseUrl ?? read("MODEL_BASE_URL") ?? "http://localhost:11434/v1";
const MODEL = read("MODEL_NAME") ?? "gemma3:1b";
const API_KEY = read("MODEL_API_KEY");
const PORT = Number(read("PORT") ?? 8080);

const SCENARIOS: Record<string, { model: string; needs: Capability; title: string }> = {
  healthy: { model: MODEL, needs: "json", title: "Healthy model" },
  tools: { model: MODEL, needs: "tools", title: "Agent needs tool calls" },
  missing: { model: "gemma3:27b", needs: "json", title: "Model never pulled" },
};

const LOGS = [
  "03:12 db: connection refused (pool exhausted)",
  "03:13 auth: user ada logged in",
  "03:15 disk: /var at 97% capacity",
];

async function runScenario(key: string) {
  const s = SCENARIOS[key];
  const ep = { baseUrl: BASE_URL, model: s.model, apiKey: API_KEY };
  const lines: string[] = [];
  let ghost = "";
  const boot = createBoot({
    onFailure: "throw", // a dashboard must stay up, so failures are returned, not fatal
    logger: { info: (m) => lines.push(m), error: (m) => lines.push(m) },
    onFailed: ghostReport(ep, { timeoutMs: 60_000, maxTokens: 120, print: (t) => { ghost = t.trim(); } }),
    onFailedTimeoutMs: 65_000,
  });
  boot.check(modelCheck(ep, { requires: [s.needs], retry: { attempts: 3, delayMs: 500, backoff: true } }));

  const t0 = performance.now();
  try {
    const { status } = await boot.start();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: `Classify each log line. Return JSON {"items":[{"line":string,"severity":"ok"|"warn"|"critical"}]}.\n${LOGS.join("\n")}`,
        }],
      }),
    });
    const out = await res.json();
    return { scenario: s, ok: true, status, report: lines.join("\n"), ghost: "", task: out?.choices?.[0]?.message?.content ?? "", ms: performance.now() - t0 };
  } catch (err) {
    const status = (err as { status?: BootStatus }).status;
    const report = (err as { report?: string }).report ?? String(err);
    return { scenario: s, ok: false, status, report, ghost, task: "", ms: performance.now() - t0 };
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bootguard</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2a313c; --text:#e6edf3; --muted:#8b949e;
          --ok:#3fb950; --bad:#f85149; --warn:#d29922; --ghost:#a371f7; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif }
  main { max-width:920px; margin:0 auto; padding:32px 16px 64px }
  h1 { margin:0; font-size:28px } h1 span { color:var(--ghost) }
  .sub { color:var(--muted); margin:6px 0 24px }
  .meta { color:var(--muted); font-size:13px; margin-bottom:20px }
  .buttons { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:24px }
  button { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px;
           padding:10px 16px; font:inherit; cursor:pointer }
  button:hover { border-color:var(--ghost) } button:disabled { opacity:.5; cursor:wait }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px }
  .card h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted) }
  .verdict { display:flex; align-items:center; gap:12px; font-size:20px; font-weight:600 }
  .pill { font-size:12px; padding:3px 10px; border-radius:99px; font-weight:700; letter-spacing:.05em }
  .pill.ok { background:rgba(63,185,80,.15); color:var(--ok) } .pill.bad { background:rgba(248,81,73,.15); color:var(--bad) }
  .pill.wait { background:rgba(210,153,34,.15); color:var(--warn) }
  table { width:100%; border-collapse:collapse; font-size:14px }
  td,th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top }
  th { color:var(--muted); font-weight:500 }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:13px/1.5 ui-monospace,Consolas,monospace }
  .ghost { border-color:rgba(163,113,247,.5) } .ghost h2 { color:var(--ghost) }
  .hidden { display:none }
</style></head>
<body><main>
  <h1>boot<span>guard</span></h1>
  <p class="sub">No AI agent boots with a ghost model. Each button runs a real boot against the model server.</p>
  <p class="meta" id="meta"></p>
  <div class="buttons">
    <button data-s="healthy">✔ Healthy model</button>
    <button data-s="tools">🛠 Agent needs tool calls</button>
    <button data-s="missing">⛔ Model never pulled</button>
  </div>
  <section id="out"></section>
</main>
<script>
  const out = document.getElementById("out");
  document.getElementById("meta").textContent = ${JSON.stringify(`Model server: ${BASE_URL} · default model: ${MODEL}${fake ? " · OFFLINE fake model" : ""}`)};
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function card(title, cls) { const c = el("div", "card " + (cls || "")); c.append(el("h2", "", title)); out.append(c); return c; }

  async function run(key, btn) {
    document.querySelectorAll("button").forEach(b => b.disabled = true);
    out.replaceChildren();
    const v = card("Verdict"); const row = el("div", "verdict"); row.append(el("span", "pill wait", "BOOTING"), el("span", "", btn.textContent + "…")); v.append(row);
    try {
      const r = await (await fetch("/api/run?s=" + key)).json();
      out.replaceChildren();
      const vc = card("Verdict"); const vr = el("div", "verdict");
      vr.append(el("span", "pill " + (r.ok ? "ok" : "bad"), r.ok ? "READY" : "REFUSED TO START"),
                el("span", "", r.scenario.title + " · " + r.scenario.model + " · needs " + r.scenario.needs));
      vc.append(vr);

      if (r.status && r.status.checks && r.status.checks.length) {
        const cc = card("Preflight checks"); const t = el("table");
        const h = el("tr"); ["", "Check", "Attempts", "Time", "Detail"].forEach(x => h.append(el("th", "", x))); t.append(h);
        r.status.checks.forEach(c => { const tr = el("tr");
          tr.append(el("td", "", c.ok ? "✔" : "✖"), el("td", "", c.name), el("td", "", String(c.attempts)),
                    el("td", "", Math.round(c.durationMs) + " ms"), el("td", "", c.error || "passed")); t.append(tr); });
        cc.append(t);
      }
      if (!r.ok) card("bootguard report (deterministic, masked)").append(el("pre", "", r.report));
      if (r.ghost && /skipped/.test(r.ghost.split("\\n")[0])) {
        card("👻 Ghost report skipped", "ghost").append(el("pre", "", "The model is the thing that failed, so it cannot explain itself. The report above is the source of truth."));
      } else if (r.ghost) {
        card("👻 Ghost report: " + r.scenario.model + " explains", "ghost").append(el("pre", "", r.ghost.replace(/^👻[^\\n]*\\n+/, "")));
      }
      if (r.ok) card("🤖 Agent output: log triage by " + r.scenario.model).append(el("pre", "", r.task));
    } catch (e) {
      out.replaceChildren(); card("Error").append(el("pre", "", String(e)));
    } finally {
      document.querySelectorAll("button").forEach(b => b.disabled = false);
    }
  }
  document.querySelectorAll("button").forEach(b => b.addEventListener("click", () => run(b.dataset.s, b)));
</script></body></html>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/run") {
      const key = url.searchParams.get("s") ?? "";
      if (!SCENARIOS[key]) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unknown scenario" }));
      }
      const result = await runScenario(key);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  })
  .listen(PORT, () => console.log(`bootguard dashboard: http://localhost:${PORT}  (model server ${BASE_URL})`));
