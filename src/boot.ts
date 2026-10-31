/**
 * The bootstrapper: env phase, then check phase, then ready / degraded /
 * failed. Lifecycle ideas taken from Fastify's avvio (one shared ready
 * promise, registration locked once boot starts) and probe semantics from
 * Lightship (liveness never consults dependencies).
 */
import { createRuntimeAdapter, type FailureMode, type RuntimeName } from "./runtime.ts";
import { validateEnv, type EnvOf, type EnvProblem, type EnvSpec } from "./env.ts";
import { runChecks, type CheckOutcome, type PreflightCheck } from "./checks.ts";
import {
  createMasker,
  formatCheckFailure,
  formatEnvReport,
  formatReady,
} from "./report.ts";

export type BootState = "starting" | "ready" | "failed";

export interface BootStatus {
  state: BootState;
  /** Ready, but at least one optional check failed. */
  degraded: boolean;
  runtime: RuntimeName;
  durationMs?: number;
  envProblems: EnvProblem[];
  checks: CheckOutcome[];
  failedRequired: string[];
  failedOptional: string[];
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export interface BootOptions<S extends EnvSpec> {
  /** Env variables to validate, as built-in validators or Standard Schemas. */
  env?: S;
  /**
   * Where to read env values from. Defaults to the runtime's own source.
   * Pass the `env` binding here on Cloudflare Workers.
   */
  source?: Record<string, string | undefined>;
  /** `exit` kills the process on failure, `throw` rejects start(). Default depends on runtime. */
  onFailure?: FailureMode;
  /** Extra env keys whose values must be masked in output. */
  secrets?: readonly string[];
  /** Where reports go. Defaults to console; pass false to silence. */
  logger?: Logger | false;
  /** Override runtime detection (mainly for tests). */
  runtime?: RuntimeName;
  /**
   * Called after the failure report is printed and before exit/throw. It
   * receives the already-masked report. Used by bootguard/ai's ghost report.
   * Time-boxed by `onFailedTimeoutMs` (default 30s); errors are swallowed,
   * so it can never block or replace the deterministic report.
   */
  onFailed?: (failure: { report: string; status: BootStatus }) => unknown;
  onFailedTimeoutMs?: number;
}

export interface BootResult<S extends EnvSpec> {
  env: EnvOf<S>;
  status: BootStatus;
}

export class BootError extends Error {
  readonly status: BootStatus;
  readonly report: string;
  constructor(report: string, status: BootStatus) {
    super(report.split("\n")[0]);
    this.name = "BootError";
    this.report = report;
    this.status = status;
  }
}

export interface Probes {
  /** 200 while the process can answer at all. Never checks dependencies. */
  live(request?: Request): Response;
  /** 200 when ready (degraded included), 503 otherwise. */
  ready(request?: Request): Response;
  /** 200 once boot has finished successfully, 503 while starting or failed. */
  startup(request?: Request): Response;
  /** Routes paths ending in /live, /ready or /startup; 404 for anything else. */
  fetch(request: Request): Response;
}

export interface Boot<S extends EnvSpec> {
  /** Register a preflight check. Throws once start() has been called. */
  check(check: PreflightCheck<EnvOf<S>>): Boot<S>;
  /**
   * Run the boot. Resolves only when ready (or degraded). On failure it
   * prints one report, then exits or throws. Safe to call more than once.
   */
  start(): Promise<BootResult<S>>;
  /** Shared barrier: resolves when boot succeeds. Does not start the boot. */
  readonly ready: Promise<BootResult<S>>;
  /** Snapshot of the current state. */
  status(): BootStatus;
  readonly probes: Probes;
}

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
};

export function createBoot<S extends EnvSpec = Record<never, never>>(
  options: BootOptions<S> = {},
): Boot<S> {
  const runtime = createRuntimeAdapter(options.runtime);
  const spec = (options.env ?? {}) as S;
  const logger = options.logger === false ? undefined : options.logger ?? consoleLogger;
  const failureMode = options.onFailure ?? runtime.defaultFailureMode;
  const checks: PreflightCheck<EnvOf<S>>[] = [];

  const status: BootStatus = {
    state: "starting",
    degraded: false,
    runtime: runtime.name,
    envProblems: [],
    checks: [],
    failedRequired: [],
    failedOptional: [],
  };

  let started: Promise<BootResult<S>> | undefined;
  let mask: (text: string) => string = (t) => t; // replaced once secrets are known
  let resolveReady!: (r: BootResult<S>) => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<BootResult<S>>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {}); // a failed boot must not also raise an unhandled rejection

  const snapshot = (): BootStatus => structuredClone(status);

  async function fail(report: string): Promise<never> {
    status.state = "failed";
    logger?.error(report); // the deterministic report always comes first
    const error = new BootError(report, snapshot());
    rejectReady(error);
    if (options.onFailed) {
      const limit = options.onFailedTimeoutMs ?? 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve()
          .then(() => options.onFailed!({ report, status: snapshot() }))
          .catch(() => {}),
        new Promise((r) => { timer = setTimeout(r, limit); }),
      ]);
      clearTimeout(timer);
    }
    if (failureMode === "exit") runtime.exit(1);
    throw error;
  }

  async function run(): Promise<BootResult<S>> {
    const t0 = performance.now();
    const read = options.source ? (k: string) => options.source![k] : runtime.readEnv;

    // Phase 1: env. Collect every problem, run no checks if any exist.
    const { env, problems, secretValues } = await validateEnv(spec, read, options.secrets);
    // Third-party validators may echo raw values in their messages, so env
    // problems are masked just like check errors.
    mask = createMasker(secretValues);
    status.envProblems = problems.map((p) => ({ ...p, message: mask(p.message) }));
    if (problems.length) return fail(formatEnvReport(status.envProblems));

    // Phase 2: checks, in parallel, each bounded by retries and timeouts.
    const outcomes = await runChecks(checks, env, mask);
    status.checks = outcomes;
    status.failedRequired = outcomes.filter((o) => !o.ok && o.required).map((o) => o.name);
    status.failedOptional = outcomes.filter((o) => !o.ok && !o.required).map((o) => o.name);
    status.durationMs = performance.now() - t0;
    if (status.failedRequired.length) return fail(formatCheckFailure(outcomes));

    status.state = "ready";
    status.degraded = status.failedOptional.length > 0;
    logger?.info(formatReady(outcomes, status.durationMs, runtime.name));
    const result = { env, status: snapshot() };
    resolveReady(result);
    return result;
  }

  const json = (body: unknown, code: number) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

  // Probe bodies carry check names only, never error text: probe endpoints
  // are often reachable from outside, and errors can reveal hostnames.
  const publicStatus = () => ({
    state: status.state,
    degraded: status.degraded,
    failedRequired: status.failedRequired,
    failedOptional: status.failedOptional,
  });

  const probes: Probes = {
    live: () => json({ status: "alive" }, 200),
    ready: () => json(publicStatus(), status.state === "ready" ? 200 : 503),
    startup: () => json(publicStatus(), status.state === "ready" ? 200 : 503),
    fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      if (path.endsWith("/live")) return probes.live(request);
      if (path.endsWith("/ready")) return probes.ready(request);
      if (path.endsWith("/startup")) return probes.startup(request);
      return json({ error: "not found" }, 404);
    },
  };

  const boot: Boot<S> = {
    check(check) {
      if (started) {
        throw new Error(`bootguard: cannot register check "${check.name}" after start() was called`);
      }
      if (checks.some((c) => c.name === check.name)) {
        throw new Error(`bootguard: a check named "${check.name}" is already registered`);
      }
      checks.push(check);
      return boot;
    },
    start() {
      started ??= run().catch((err) => {
        if (err instanceof BootError) throw err;
        // A bug inside the engine or a validator: still fail loudly, once.
        return fail(mask(`bootguard ✖ boot failed: unexpected error\n\n  ${String(err?.stack ?? err)}`));
      });
      return started;
    },
    ready,
    status: snapshot,
    probes,
  };
  return boot;
}
