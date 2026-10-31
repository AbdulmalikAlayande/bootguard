/**
 * The bootstrapper: env phase, then check phase, then ready / degraded /
 * failed. Lifecycle ideas taken from Fastify's avvio (one shared ready
 * promise, registration locked once boot starts) and probe semantics from
 * Lightship (liveness never consults dependencies).
 */
import { type FailureMode, type RuntimeName } from "./runtime.ts";
import { type EnvOf, type EnvProblem, type EnvSpec } from "./env.ts";
import { type CheckOutcome, type PreflightCheck } from "./checks.ts";
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
    onFailed?: (failure: {
        report: string;
        status: BootStatus;
    }) => unknown;
    onFailedTimeoutMs?: number;
}
export interface BootResult<S extends EnvSpec> {
    env: EnvOf<S>;
    status: BootStatus;
}
export declare class BootError extends Error {
    readonly status: BootStatus;
    readonly report: string;
    constructor(report: string, status: BootStatus);
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
export declare function createBoot<S extends EnvSpec = Record<never, never>>(options?: BootOptions<S>): Boot<S>;
