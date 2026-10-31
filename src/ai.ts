/**
 * bootguard/ai: preflight for agents that run on open-weight models.
 *
 * A model server can be up, answer its health route, and still have no
 * working model behind it: the model was never pulled, its weights are still
 * loading, or it cannot do what the agent needs (tool calls, JSON). That
 * agent is a ghost in the machine. modelCheck() catches every one of those
 * before the agent accepts work, against any OpenAI-compatible server
 * (Ollama, llama.cpp server, vLLM, LM Studio, and hosted endpoints).
 *
 * ghostReport() is the other half: when boot fails, a local open-weight
 * model reads bootguard's (already masked) report and explains the fix in
 * plain English. The deterministic report is always printed first.
 */
import { FatalCheckError, type PreflightCheck } from "./checks.ts";
import type { BootStatus } from "./boot.ts";

export interface ModelEndpoint {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string;
  /** Model id as the server knows it, e.g. gemma3:1b. */
  model: string;
  /** Sent as a Bearer token when set. Local servers usually ignore it. */
  apiKey?: string;
}

export type Capability = "json" | "tools";

export interface ModelCheckOptions {
  /** Check name in reports. Default "model". */
  name?: string;
  /** Capabilities the agent depends on. Each one is proven with a real call. */
  requires?: readonly Capability[];
  /** Smoke prompt. Default asks for a one-word reply. */
  prompt?: string;
  /** Pattern the smoke reply must match. Default: any non-empty reply. */
  expect?: RegExp;
  /** Default true. */
  required?: boolean;
  /** Default: 6 attempts, backoff from 1s. Covers weights loading. */
  retry?: PreflightCheck<unknown>["retry"];
  /** Per attempt. Default 60s, because a cold model can take a while. */
  timeoutMs?: number;
}

type EndpointSource<E> = ModelEndpoint | ((env: E) => ModelEndpoint);

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** Errors a retry cannot fix fail immediately; everything else is retried. */
async function call(
  ep: ModelEndpoint,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal },
  step: string,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${trimSlash(ep.baseUrl)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (err) {
    // Each runtime words this differently; Node puts the code on err.cause.
    const reason = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    throw new Error(`${step}: cannot reach ${trimSlash(ep.baseUrl)} (${reason})`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const detail = body?.error?.message ?? body?.error ?? body?.raw ?? res.statusText;
    const message = `${step}: HTTP ${res.status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    // 4xx means the request itself is wrong (bad key, missing model, no tool
    // support): retrying sends the same wrong request. 408/429 are transient.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new FatalCheckError(message);
    }
    throw new Error(message);
  }
  return body;
}

function chat(ep: ModelEndpoint, extra: Record<string, unknown>, signal: AbortSignal, step: string) {
  return call(
    ep,
    "/chat/completions",
    { method: "POST", signal, body: { model: ep.model, temperature: 0, max_tokens: 64, ...extra } },
    step,
  );
}

/**
 * One check that proves the model is genuinely usable, in order:
 * server reachable, model present, model answers, required capabilities work.
 * Steps run inside one check because each depends on the previous one.
 */
export function modelCheck<E = unknown>(
  endpoint: EndpointSource<E>,
  options: ModelCheckOptions = {},
): PreflightCheck<E> {
  return {
    name: options.name ?? "model",
    required: options.required ?? true,
    retry: options.retry ?? { attempts: 6, delayMs: 1_000, backoff: true, maxDelayMs: 8_000 },
    timeoutMs: options.timeoutMs ?? 60_000,
    run: async ({ env, signal }) => {
      const ep = typeof endpoint === "function" ? endpoint(env) : endpoint;

      // 1. Server reachable, and 2. model present. Some servers have no
      // /models route (404) or list nothing useful; then step 3 is the proof,
      // since a missing model makes the chat call fail with its own 404.
      let ids: string[] = [];
      try {
        const list = await call(ep, "/models", { signal }, "server");
        ids = (list?.data ?? []).map((m: { id: string }) => m.id);
      } catch (err) {
        if (!(err instanceof FatalCheckError && /HTTP 404/.test(err.message))) throw err;
      }
      // Hosted routers (Hugging Face) accept "org/model:provider" while listing
      // "org/model", and may not list every model they can serve. So the list
      // is a hint, not the verdict: the chat call below is the real proof.
      const listed =
        !ids.length ||
        ids.some((id) => id === ep.model || id === `${ep.model}:latest` || ep.model.startsWith(`${id}:`));

      // 3. Model answers. On a cold server this is where weights load.
      let smoke;
      try {
        smoke = await chat(
          ep,
          { messages: [{ role: "user", content: options.prompt ?? "Reply with the single word READY." }] },
          signal,
          "smoke prompt",
        );
      } catch (err) {
        if (!listed && err instanceof FatalCheckError) {
          const hint = /:11434\b/.test(ep.baseUrl) ? ` Run: ollama pull ${ep.model}.` : "";
          const shown = ids.slice(0, 5).join(", ") + (ids.length > 5 ? `, … ${ids.length - 5} more` : "");
          throw new FatalCheckError(`model "${ep.model}" is not on this server (has: ${shown}).${hint}`);
        }
        throw err;
      }
      // Any completed choice proves inference works. Reasoning models may spend
      // the whole token budget thinking and return empty content; that still counts.
      if (!smoke?.choices?.length) throw new Error("smoke prompt: server returned no completion");
      const reply: string = smoke.choices[0]?.message?.content ?? "";
      if (options.expect && !options.expect.test(reply)) {
        throw new FatalCheckError(`smoke prompt: reply did not match ${options.expect} (got "${reply.slice(0, 60)}")`);
      }

      // 4. Capabilities the agent depends on.
      for (const cap of options.requires ?? []) {
        if (cap === "json") {
          const res = await chat(
            ep,
            {
              response_format: { type: "json_object" },
              messages: [{ role: "user", content: 'Return JSON exactly like {"ok": true}.' }],
            },
            signal,
            "json capability",
          );
          // Some models wrap JSON in a markdown fence even in JSON mode.
          const raw: string = res?.choices?.[0]?.message?.content ?? "";
          const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
          try {
            JSON.parse(unfenced);
          } catch {
            throw new FatalCheckError("json capability: model did not return valid JSON");
          }
        }
        if (cap === "tools") {
          const res = await chat(
            ep,
            {
              messages: [{ role: "user", content: "What time is it? Use the tool." }],
              tools: [{
                type: "function",
                function: { name: "get_time", description: "Current time", parameters: { type: "object", properties: {} } },
              }],
            },
            signal,
            "tools capability",
          );
          if (!res?.choices?.[0]?.message?.tool_calls?.length) {
            throw new FatalCheckError("tools capability: model answered without calling the tool");
          }
        }
      }
    },
  };
}

export interface GhostReportOptions {
  /** Where the explanation is printed. Default console.error. */
  print?: (text: string) => void;
  /** Max tokens for the explanation. Default 300. */
  maxTokens?: number;
  /** Name of the check that probes this same model, so a dead model is not asked to explain itself. Default "model". */
  modelCheckName?: string;
  /** Give up on the explanation after this long. Default 25s. */
  timeoutMs?: number;
}

const GHOST_PROMPT = `You are an on-call engineer. A service refused to start and printed the report below.
Explain in plain English, in at most 5 short bullet points:
- what is wrong, and
- the exact command or config change that fixes it.
Use only facts from the report. "****" marks masked secrets; never guess them.`;

/**
 * Returns an onFailed hook for createBoot(). It asks a local open-weight
 * model to explain the failure report. It skips itself when the model is the
 * thing that failed (a dead model cannot explain itself) and stays silent on
 * any error, so the deterministic report is never at risk.
 */
export function ghostReport(endpoint: ModelEndpoint, options: GhostReportOptions = {}) {
  const print = options.print ?? ((t: string) => console.error(t));
  const checkName = options.modelCheckName ?? "model";
  return async ({ report, status }: { report: string; status: BootStatus }) => {
    // Skip only when the model cannot answer at all. A model that answers but
    // lacks a capability (say, tools) is still perfectly able to explain.
    const modelDown = status.checks.some(
      (c) => c.name === checkName && !c.ok && /^(server:|model "|smoke prompt:|timed out)/.test(c.error ?? ""),
    );
    if (modelDown) {
      print(`\n👻 ghost report skipped: the model is the thing that failed, so it cannot explain itself.`);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
    try {
      const res = await call(
        endpoint,
        "/chat/completions",
        {
          method: "POST",
          signal: controller.signal,
          body: {
            model: endpoint.model,
            temperature: 0.2,
            max_tokens: options.maxTokens ?? 300,
            messages: [
              { role: "system", content: GHOST_PROMPT },
              { role: "user", content: report },
            ],
          },
        },
        "ghost report",
      );
      const text: string = res?.choices?.[0]?.message?.content?.trim() ?? "";
      const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(endpoint.baseUrl);
      if (text) print(`\n👻 ghost report (explained by ${endpoint.model}, ${local ? "running locally" : "hosted"})\n\n${text}`);
    } catch {
      // Diagnostics must never fail the diagnosis: the plain report already printed.
    } finally {
      clearTimeout(timer);
      controller.abort(); // never leave a request dangling
    }
  };
}
