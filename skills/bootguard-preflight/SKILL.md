---
name: bootguard-preflight
description: Add fail-fast boot checks to a JavaScript or TypeScript service or AI agent with bootguard, so it refuses to start until its env is valid and its dependencies (databases, APIs, and open-weight model servers such as Ollama, llama.cpp or vLLM) actually work. Use when asked to add startup validation, readiness or health probes, model availability checks, or "make sure the agent does not start without its model".
license: MIT
metadata:
  version: "0.1.0"
---

# bootguard preflight

bootguard runs two phases before a service accepts work:

1. **Env**: validates every variable and reports all problems at once.
2. **Checks**: runs all registered checks in parallel, each with its own retry policy and per-attempt timeout.

Outcomes: **ready**, **degraded** (only optional checks failed), or **failed** (it prints one masked report, then exits with code 1, or throws on Workers).

## Steps

1. **Find the entry point.** Locate where the server starts listening or the agent loop begins (`Bun.serve`, `app.listen`, `Deno.serve`, `main()`). Boot must finish before that line runs.

2. **Inventory env vars.** Grep for `process.env.`, `Bun.env.` and `Deno.env.get(`. Declare each one in the `env` spec:
   - URLs use `url()`. Ports use `port()`. Flags use `bool()`. Numbers use `num()`. Everything else uses `str()`.
   - Add `secret: true` to passwords, tokens and keys, so their values are masked in output.
   - Use `default` or `optional: true` **only** if the code already tolerates the value being absent.

3. **Inventory dependencies.** List every external system the code calls at runtime. Add one check for each:
   - Read connection details from the `env` argument, never from `process.env` directly.
   - Pass `signal` to `fetch` or to the client, so a timeout cancels the call.
   - Use `required: false` only for things the service can genuinely serve without (analytics, optional caches).
   - Give network dependencies a retry policy, e.g. `retry: { attempts: 5, delayMs: 500, backoff: true }`.
   - Throw `FatalCheckError` for errors a retry cannot fix (bad credentials, a missing resource), so the check fails at once instead of retrying.

4. **AI agents.** If the code calls an LLM through an OpenAI-compatible API, add `modelCheck` from `bootguard/ai`:
   - Put each capability the code actually uses in `requires`: `"json"` if it sends `response_format`, `"tools"` if it sends `tools`. Never add a capability the code does not use.
   - Add `onFailed: ghostReport(endpoint)` so the local model explains failures in plain English. The plain report is always printed first.

5. **Probes** (only if the service is deployed behind a load balancer or orchestrator): mount `boot.probes.fetch` on a path such as `/health/*`. Never add dependency checks to liveness.

6. **Verify.** Start the service once with a required variable unset and confirm it exits with the env report. Start it once with a dependency stopped and confirm it retries, then fails.

## Template

```ts
import { createBoot, url, str, port } from "bootguard";
import { modelCheck, ghostReport } from "bootguard/ai";

const model = { baseUrl: "http://localhost:11434/v1", model: "gemma3:1b" };

const boot = createBoot({
  env: {
    DATABASE_URL: url({ secret: true }),
    PORT: port({ default: 3000 }),
    MODEL_NAME: str({ default: "gemma3:1b" }),
  },
  onFailed: ghostReport(model),
});

boot.check({
  name: "database",
  retry: { attempts: 5, delayMs: 500, backoff: true },
  run: ({ env, signal }) => db.ping(env.DATABASE_URL, { signal }),
});

boot.check(
  modelCheck((env) => ({ ...model, model: env.MODEL_NAME }), { requires: ["json"] }),
);

const { env } = await boot.start(); // only returns when it is safe to serve
```

## Do not

- Do not catch the error from `boot.start()` and carry on anyway. That defeats the purpose.
- Do not mark a dependency optional just to make boot pass.
- Do not log raw env values yourself. Rely on bootguard's masked reports.
