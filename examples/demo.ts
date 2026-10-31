/**
 * One demo, unchanged on Node, Bun and Deno. The "database" is a real TCP
 * listener, so the check proves reachability, not just a well-formed URL.
 *
 *   SCENARIO=late node --experimental-strip-types examples/demo.ts
 *   SCENARIO=late bun examples/demo.ts
 *   SCENARIO=late deno run --allow-env --allow-net examples/demo.ts
 *
 * Or run all four scenarios on one runtime with examples/run-demo.sh.
 */
import net from "node:net";
import { createBoot, port, str, url } from "../src/index.ts";

const env = (k: string): string | undefined =>
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno?.env.get(k) ?? (globalThis as any).process?.env[k];
const scenario = env("SCENARIO") ?? "late";

/** Open a TCP connection to the host and port in a URL, then close it. */
function tcpPing(target: string, signal: AbortSignal): Promise<void> {
  const { hostname, port } = new URL(target);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    const finish = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", (e) => finish(e));
    signal.addEventListener("abort", () => finish(new Error("aborted")));
  });
}

/** A stand-in database: a TCP server that starts listening after `delayMs`. */
function fakeDatabase(delayMs: number): { listening: Promise<void>; close(): void } {
  const server = net.createServer((s) => s.end());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listening = new Promise<void>((resolve) => {
    timer = setTimeout(() => server.listen(5433, "127.0.0.1", resolve), delayMs);
  });
  return { listening, close: () => { clearTimeout(timer); server.close(); } };
}

const database = scenario === "late" ? fakeDatabase(900) : scenario === "degraded" ? fakeDatabase(0) : null;
if (scenario === "degraded") await database!.listening;

const boot = createBoot({
  env: {
    DATABASE_URL: url({ secret: true }),
    ANALYTICS_URL: url({ optional: true }),
    PORT: port({ default: 3000 }),
    SESSION_SECRET: str({ desc: "signs session cookies" }),
  },
});

boot.check({
  name: "database",
  retry: { attempts: 5, delayMs: 250, backoff: true },
  timeoutMs: 1_000,
  run: async ({ env, signal }) => {
    try {
      await tcpPing(env.DATABASE_URL, signal);
    } catch (err) {
      // Deliberately includes the URL: bootguard masks the password on output.
      throw new Error(`cannot reach ${env.DATABASE_URL} (${(err as { code?: string }).code ?? err})`);
    }
  },
});

boot.check({
  name: "analytics",
  required: false,
  retry: { attempts: 2, delayMs: 100 },
  timeoutMs: 500,
  run: async ({ env, signal }) => {
    if (env.ANALYTICS_URL) await tcpPing(env.ANALYTICS_URL, signal);
  },
});

const { env: config } = await boot.start(); // exits with code 1 on failure

const res = boot.probes.ready();
console.log(`\nGET /ready -> ${res.status} ${await res.text()}`);
console.log(`serving on port ${config.PORT} (demo ends here)`);
database?.close();
