# bootguard

**No agent should boot with a ghost model.**

Your agent's process is up, and its model server answers its health route. But the model was never pulled, or its weights are still loading, or it cannot make the tool calls your agent depends on. The agent looks alive and has nothing inside it.

bootguard is a zero-dependency preflight harness. It proves that an open-weight model, and everything else a service depends on, **actually works** before the service accepts any work. When boot fails, a local open-weight model reads the failure report and explains the fix.

```
bootguard ✖ boot failed: 1 required check did not pass

  ✖ model   required · 1 attempt · 6ms · tools capability: HTTP 400 gemma3:1b does not support tools

👻 ghost report (explained locally by gemma3:1b)

- The agent needs tool calling, but this model has no tool support.
- Switch MODEL_NAME to a model that supports tools, e.g. `ollama pull qwen2.5:1.5b`.
```

It runs the same way on Node, Bun and Deno, and with honest limits on Cloudflare Workers.

## Open-weight AI: `bootguard/ai`

```ts
import { createBoot } from "bootguard";
import { modelCheck, ghostReport } from "bootguard/ai";

const model = { baseUrl: "http://localhost:11434/v1", model: "gemma3:1b" }; // Ollama

const boot = createBoot({ onFailed: ghostReport(model) });
boot.check(modelCheck(model, { requires: ["json"] }));
await boot.start(); // only returns when the model is genuinely usable
```

`modelCheck` works against any OpenAI-compatible server (Ollama, llama.cpp server, vLLM, LM Studio). It proves four things, in order:

| Step | Catches | On failure |
|---|---|---|
| Server reachable | Ollama not running | retried |
| Model present | model never pulled (it suggests `ollama pull <model>`) | fails at once |
| Smoke prompt answers | weights still loading, cold start | retried with backoff |
| Required capability works (`json`, `tools`) | e.g. gemma3 rejects tool calls | fails at once |

The rule for retries: 4xx errors are permanent, so retrying would only send the same wrong request again. 5xx errors, timeouts and refused connections are transient, so they are retried. Any check can opt into this by throwing `FatalCheckError`.

`ghostReport` is the first-class diagnosis:
- bootguard's deterministic, masked report always prints first.
- The local model then explains the cause and the fix.
- It is capped at 30 seconds and is silent on any error.
- It skips itself when the model is the thing that is down, since a dead model cannot explain itself.
- With a local model (Ollama on localhost), the failure report never leaves your machine. If you point `ghostReport` at a hosted endpoint, the report is sent there, already masked.

### Ghost-proof agent demo

```sh
ollama pull gemma3:1b            # about 800 MB
bun examples/agent.ts            # live: refuses to start until the model is ready, then triages logs

# offline, no model needed (a built-in fake server reproduces real failure modes):
FAKE_MODEL=healthy bun examples/agent.ts   # ready, does the task
FAKE_MODEL=loading bun examples/agent.ts   # retries while weights load, then ready
FAKE_MODEL=missing bun examples/agent.ts   # refuses: model not pulled
FAKE_MODEL=down    bun examples/agent.ts   # refuses: server down (ghost report skipped)
FAKE_MODEL=notools bun examples/agent.ts   # refuses: no tool support; the ghost explains
```

### Agent skill

`skills/bootguard-preflight/SKILL.md` is an [Agent Skills](https://www.mdskills.ai/specs/skill-md) file that teaches coding agents to add bootguard to any service or AI agent. To install it in Claude Code, copy the folder into `.claude/skills/`.

## The problem, beyond AI

Getting a service safely to "ready" usually means stitching together four unrelated tools: an env validator (Envalid, T3 Env), hand-written database pings in `main` with no retry or timeout, health routes (Lightship), and signal handling. Each one fails in its own way, and most assume Node. None of them notice that a `DATABASE_URL` which passes every format check still points at a database that refuses connections. You find out on the first real request.

## How it works

Boot runs in two phases, and each phase reports every problem it finds before stopping.

1. **Env.** Every variable is validated. All missing and invalid values are reported together, and no checks run while the config is broken.
2. **Checks.** Every registered check runs in parallel. Each one gets the **validated, typed env**, its own retry policy and a per-attempt timeout.

The result is one of three states:

| Outcome | When | `start()` | `/ready` |
|---|---|---|---|
| **ready** | every check passed | resolves | 200 |
| **degraded** | every required check passed, one or more optional checks failed | resolves | 200, with `degraded: true` |
| **failed** | env invalid, or a required check never passed | prints the report, then exits (or throws) | 503 |

## Usage

```ts
import { createBoot, url, port, str } from "bootguard";

const boot = createBoot({
  env: {
    DATABASE_URL: url({ secret: true }),
    ANALYTICS_URL: url({ optional: true }),
    PORT: port({ default: 3000 }),
    SESSION_SECRET: str(),
  },
});

boot.check({
  name: "database",
  retry: { attempts: 5, delayMs: 250, backoff: true },
  timeoutMs: 1_000,
  run: ({ env, signal }) => db.ping(env.DATABASE_URL, { signal }), // env is fully typed
});

boot.check({
  name: "analytics",
  required: false, // failure leaves the service ready but degraded
  run: ({ env }) => analytics.ping(env.ANALYTICS_URL),
});

const { env } = await boot.start(); // only returns when it is safe to serve
Bun.serve({ port: env.PORT, fetch: app.fetch });
```

### Env validators

`str`, `num`, `bool`, `port`, `url` and `json`. Each takes these options: `default`, `optional`, `secret`, `choices` and `desc`. A blank or whitespace-only value counts as missing. Error messages never include the raw value.

You can also use **any [Standard Schema](https://standardschema.dev) validator** (Zod, Valibot, ArkType) in the same spec, without bootguard depending on any of them. Because `start()` is async, these validators may also be async.

```ts
import { z } from "zod";
createBoot({ env: { REGION: z.enum(["eu", "us"]), PORT: port() } });
```

### Checks

```ts
interface PreflightCheck<Env> {
  name: string;
  required?: boolean;             // default true: fail closed
  run(ctx: { env: Env; signal: AbortSignal; attempt: number }): unknown; // throw to fail
  retry?: { attempts: number; delayMs?: number; backoff?: boolean; maxDelayMs?: number };
  timeoutMs?: number;             // per attempt, default 5000
}
```

A check that hangs is timed out and its `signal` is aborted, so `fetch` calls and database clients that accept a signal get cancelled. Registering a check after `start()` throws instead of being silently ignored.

### Secrets

Values of variables marked `secret: true`, or whose names look secret (`*_SECRET`, `*_TOKEN`, `*PASSWORD*`, `*_KEY`, ...), are masked in every report. So are passwords inside any URL (`postgres://app:****@db`). This covers the common case where a database driver echoes its connection string in an error message.

### Probes and status

bootguard does not start its own server. It gives you handlers to mount wherever you already serve traffic:

```ts
boot.probes.live();     // 200 while the process answers. Never checks dependencies.
boot.probes.ready();    // 200 when ready or degraded, 503 otherwise
boot.probes.startup();  // 200 once boot succeeded
boot.probes.fetch(req); // routes */live, */ready, */startup; 404 otherwise

Deno.serve({ port: 9000 }, boot.probes.fetch);
app.get("/health/*", (c) => boot.probes.fetch(c.req.raw)); // Hono
```

Probe responses contain check **names** only, never error text, because probe endpoints are often reachable from outside the service. For full detail inside your process, call `boot.status()`.

`boot.ready` is a shared promise that resolves when boot succeeds. Other modules can await it without starting the boot themselves.

## Runtimes

| Runtime | Env source | On failure |
|---|---|---|
| Node | `process.env` | exit 1 |
| Bun | `Bun.env` | exit 1 |
| Deno | `Deno.env.get(key)` per key, so `--allow-env=KEY1,KEY2` is enough | exit 1 |
| Cloudflare Workers | pass `source: env` (or `process.env` under `nodejs_compat`) | throws `BootError` |

On Workers, call `boot.start()` inside your `fetch` handler (and reuse the promise), because Workers do not allow I/O at global scope.

Set `onFailure: "throw"` to receive a `BootError` (with `.report` and `.status`) instead of exiting the process. That is the right choice in tests.

## Demo

```sh
./examples/run-demo.sh node   # or bun, or deno
```

The demo runs four scenarios against a real TCP listener standing in for a database:

1. Broken config: every problem is shown at once.
2. Database down: the check retries, then the boot fails with the password masked.
3. Database comes up late: the service becomes ready after retries.
4. Optional analytics down: the service is ready but degraded.

## Tests

```sh
npm test   # 45 tests, the same suite on Node, Bun and Deno, no model download needed
npm run build   # compiles src/ to dist/ (JavaScript plus .d.ts), which is what the package exports
```

## Install

bootguard is not on npm yet. Install it from GitHub:

```sh
npm i github:<owner>/bootguard     # or: bun add github:<owner>/bootguard
```

It ships compiled JavaScript with type declarations, so it works on Node (tested on 22), Bun and Deno without a TypeScript loader.

## What is verified, and what is not

**Verified:**
- The same 45 tests pass on Node 22, Bun 1.4 and Deno 2.9.
- `tsc` strict mode is clean.
- The installed package is consumed successfully on all three runtimes.
- Real Zod 4, Valibot 1 and ArkType 2 schemas work alongside the built-in validators.
- Every `bootguard/ai` failure mode is tested against a fake OpenAI-compatible server that imitates Ollama's behaviour: a missing model, weights still loading, no tool support, no `/models` route, reasoning models that return empty content, and JSON wrapped in code fences.

**Not yet verified:**
- **A real Ollama run.** The demo is written for `gemma3:1b`, but CI cannot download model weights. Ollama's exact HTTP status for "does not support tools" is not confirmed. If it is a 5xx rather than a 4xx, the check retries before failing: slower, but the same clear report.
- **Real Cloudflare Workers.** Workers mode is tested only by forcing the runtime setting.

## Not in scope (yet)

- **`.env` loading.** Bun loads it automatically, and Node and Deno both have `--env-file`.
- **Client and server variable splitting.** That is a bundler concern, and T3 Env already does it well.
- **Graceful shutdown, and ordering between checks** (`dependsOn`). Both are planned. For now, do dependent steps inside a single check.

## Credits

bootguard is original code, but its design borrows openly from these projects:

- [Envalid](https://github.com/af/envalid): validators as objects with a parse function, collecting every error before reporting, never echoing raw values, and the round-trip check for ports.
- [T3 Env](https://github.com/t3-oss/t3-env): accepting any Standard Schema validator through a copied, types-only interface.
- [Standard Schema](https://standardschema.dev): the shared validator interface (`src/standard.ts`).
- [@cross/runtime](https://github.com/cross-org/runtime): the runtime detection order.
- [avvio](https://github.com/fastify/avvio) (Fastify): one shared ready barrier and locking registration once boot starts.
- [Lightship](https://github.com/gajus/lightship): probe semantics, with liveness that never consults dependencies.
- [Ollama](https://ollama.com) and [Gemma](https://ai.google.dev/gemma): the open-weight runtime and model the demo runs on.
- [DoltHub's pull-first Ollama image](https://dolthub.com/blog/2025-03-19-a-pull-first-ollama-docker-image): evidence that "the server is healthy but the model is missing" is a real problem.

## License

MIT
