/**
 * Ghost-proof agent: a log-triage agent that refuses to start until its
 * open-weight model is genuinely usable, then does one real task.
 *
 * Live (Ollama on your machine, nothing to configure):
 *   ollama pull gemma3:1b
 *   bun examples/agent.ts
 *
 * Offline (built-in fake model server), pick a scenario:
 *   FAKE_MODEL=healthy|loading|missing|down|notools bun examples/agent.ts
 */
import { createBoot, str, url } from "../src/index.ts";
import { ghostReport, modelCheck, type Capability } from "../src/ai.ts";
import { startFakeModelServer } from "./fake-model-server.ts";

const read = (k: string): string | undefined =>
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno?.env.get(k) ?? (globalThis as any).process?.env[k];

// Offline scenarios stand up a fake OpenAI-compatible server in-process.
const fake = read("FAKE_MODEL");
const fakeServer =
  fake && fake !== "down"
    ? await startFakeModelServer({
        models: fake === "missing" ? ["llama3:8b"] : ["gemma3:1b"],
        loadingMs: fake === "loading" ? 2_500 : 0,
        tools: false,
      })
    : undefined;
const source = {
  MODEL_BASE_URL: fake === "down" ? "http://127.0.0.1:9/v1" : fakeServer?.baseUrl ?? read("MODEL_BASE_URL"),
  MODEL_NAME: read("MODEL_NAME"),
  MODEL_API_KEY: read("MODEL_API_KEY"),
  AGENT_NEEDS: fake === "notools" ? "tools" : read("AGENT_NEEDS"),
};

const boot = createBoot({
  source,
  env: {
    MODEL_BASE_URL: url({ default: "http://localhost:11434/v1" }),
    MODEL_NAME: str({ default: "gemma3:1b" }),
    MODEL_API_KEY: str({ optional: true, secret: true }),
    AGENT_NEEDS: str({ default: "json", choices: ["json", "tools"] }),
  },
  // The plain report prints first; then the local model explains it.
  onFailed: ({ report, status }) =>
    ghostReport({
      baseUrl: source.MODEL_BASE_URL ?? "http://localhost:11434/v1",
      model: source.MODEL_NAME ?? "gemma3:1b",
      apiKey: source.MODEL_API_KEY,
    })({ report, status }),
  onFailedTimeoutMs: 45_000,
});

boot.check(
  modelCheck(
    (env) => ({ baseUrl: env.MODEL_BASE_URL, model: env.MODEL_NAME, apiKey: env.MODEL_API_KEY }),
    {
      // The capability this agent depends on; validated as json|tools above.
      requires: [(source.AGENT_NEEDS ?? "json") as Capability],
      retry: { attempts: 5, delayMs: 500, backoff: true },
    },
  ),
);

const { env: config } = await boot.start(); // exits with code 1 if the model is a ghost

// ---- The agent's actual job: triage log lines into structured JSON. ----
const logs = [
  "03:12 db: connection refused (pool exhausted)",
  "03:13 auth: user ada logged in",
  "03:15 disk: /var at 97% capacity",
];
console.log(`\n🤖 agent online, model ${config.MODEL_NAME}. Triaging ${logs.length} log lines...`);

const res = await fetch(`${config.MODEL_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(config.MODEL_API_KEY ? { authorization: `Bearer ${config.MODEL_API_KEY}` } : {}) },
  body: JSON.stringify({
    model: config.MODEL_NAME,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: `Classify each log line. Return JSON {"items":[{"line":string,"severity":"ok"|"warn"|"critical"}]}.\n${logs.join("\n")}`,
    }],
  }),
});
const out = await res.json();
console.log(out?.choices?.[0]?.message?.content ?? out);
await fakeServer?.close();
