/**
 * The bootstrapper: env phase, then check phase, then ready / degraded /
 * failed. Lifecycle ideas taken from Fastify's avvio (one shared ready
 * promise, registration locked once boot starts) and probe semantics from
 * Lightship (liveness never consults dependencies).
 */
import { createRuntimeAdapter } from "./runtime.js";
import { validateEnv } from "./env.js";
import { runChecks } from "./checks.js";
import { createMasker, formatCheckFailure, formatEnvReport, formatReady, } from "./report.js";
export class BootError extends Error {
    status;
    report;
    constructor(report, status) {
        super(report.split("\n")[0]);
        this.name = "BootError";
        this.report = report;
        this.status = status;
    }
}
const consoleLogger = {
    info: (m) => console.log(m),
    error: (m) => console.error(m),
};
export function createBoot(options = {}) {
    const runtime = createRuntimeAdapter(options.runtime);
    const spec = (options.env ?? {});
    const logger = options.logger === false ? undefined : options.logger ?? consoleLogger;
    const failureMode = options.onFailure ?? runtime.defaultFailureMode;
    const checks = [];
    const status = {
        state: "starting",
        degraded: false,
        runtime: runtime.name,
        envProblems: [],
        checks: [],
        failedRequired: [],
        failedOptional: [],
    };
    let started;
    let mask = (t) => t; // replaced once secrets are known
    let resolveReady;
    let rejectReady;
    const ready = new Promise((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
    });
    ready.catch(() => { }); // a failed boot must not also raise an unhandled rejection
    const snapshot = () => structuredClone(status);
    async function fail(report) {
        status.state = "failed";
        logger?.error(report); // the deterministic report always comes first
        const error = new BootError(report, snapshot());
        rejectReady(error);
        if (options.onFailed) {
            const limit = options.onFailedTimeoutMs ?? 30_000;
            let timer;
            await Promise.race([
                Promise.resolve()
                    .then(() => options.onFailed({ report, status: snapshot() }))
                    .catch(() => { }),
                new Promise((r) => { timer = setTimeout(r, limit); }),
            ]);
            clearTimeout(timer);
        }
        if (failureMode === "exit")
            runtime.exit(1);
        throw error;
    }
    async function run() {
        const t0 = performance.now();
        const read = options.source ? (k) => options.source[k] : runtime.readEnv;
        // Phase 1: env. Collect every problem, run no checks if any exist.
        const { env, problems, secretValues } = await validateEnv(spec, read, options.secrets);
        // Third-party validators may echo raw values in their messages, so env
        // problems are masked just like check errors.
        mask = createMasker(secretValues);
        status.envProblems = problems.map((p) => ({ ...p, message: mask(p.message) }));
        if (problems.length)
            return fail(formatEnvReport(status.envProblems));
        // Phase 2: checks, in parallel, each bounded by retries and timeouts.
        const outcomes = await runChecks(checks, env, mask);
        status.checks = outcomes;
        status.failedRequired = outcomes.filter((o) => !o.ok && o.required).map((o) => o.name);
        status.failedOptional = outcomes.filter((o) => !o.ok && !o.required).map((o) => o.name);
        status.durationMs = performance.now() - t0;
        if (status.failedRequired.length)
            return fail(formatCheckFailure(outcomes));
        status.state = "ready";
        status.degraded = status.failedOptional.length > 0;
        logger?.info(formatReady(outcomes, status.durationMs, runtime.name));
        const result = { env, status: snapshot() };
        resolveReady(result);
        return result;
    }
    const json = (body, code) => new Response(JSON.stringify(body), {
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
    const probes = {
        live: () => json({ status: "alive" }, 200),
        ready: () => json(publicStatus(), status.state === "ready" ? 200 : 503),
        startup: () => json(publicStatus(), status.state === "ready" ? 200 : 503),
        fetch(request) {
            const path = new URL(request.url).pathname.replace(/\/+$/, "");
            if (path.endsWith("/live"))
                return probes.live(request);
            if (path.endsWith("/ready"))
                return probes.ready(request);
            if (path.endsWith("/startup"))
                return probes.startup(request);
            return json({ error: "not found" }, 404);
        },
    };
    const boot = {
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
                if (err instanceof BootError)
                    throw err;
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
