# bootguard

**Your env validator checks that your config looks right. bootguard checks that it works.**

A zero-dependency library that takes a service from "the process started" to either **ready** or **dead with one clear report**. It runs the same way on Node, Bun and Deno, and with honest limits on Cloudflare Workers.

```
bootguard ✖ boot failed: 1 required check did not pass

  ✖ database    required · 5 attempts · 3.76s · cannot reach postgres://app:****@127.0.0.1:5433/app (ECONNREFUSED)
  ✔ analytics   optional · 1 attempt · 1ms
```

## The problem

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
npm test   # the same suite on Node, Bun and Deno
```

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

## License

MIT
