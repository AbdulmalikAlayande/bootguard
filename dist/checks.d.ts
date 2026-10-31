/**
 * Phase 2: preflight checks. All checks run in parallel; each one has its
 * own retry policy and a per-attempt timeout, so no single check can hold
 * the boot forever. A check never rejects here: every result, pass or fail,
 * is collected so the report can show all of them at once.
 */
export interface CheckContext<E> {
    /** The validated, typed env from phase 1. */
    readonly env: E;
    /** Aborted when this attempt times out. Pass it to fetch() or your client. */
    readonly signal: AbortSignal;
    /** 1 on the first try, 2 on the first retry, and so on. */
    readonly attempt: number;
}
export interface RetryPolicy {
    /** Total tries, including the first. */
    attempts: number;
    /** Wait between tries. Default 500ms. */
    delayMs?: number;
    /** Double the wait after each failed try. Default false. */
    backoff?: boolean;
    /** Upper bound on the wait when backoff is on. Default 30s. */
    maxDelayMs?: number;
}
export interface PreflightCheck<E> {
    name: string;
    /**
     * Required checks fail the boot when they never pass. Optional checks
     * leave the service ready but degraded. Defaults to true (fail closed).
     */
    required?: boolean;
    /** Throw (or reject) to fail. Any return value counts as a pass. */
    run: (ctx: CheckContext<E>) => unknown;
    retry?: RetryPolicy;
    /** Per-attempt time limit. Default 5000ms. */
    timeoutMs?: number;
}
export interface CheckOutcome {
    name: string;
    required: boolean;
    ok: boolean;
    attempts: number;
    durationMs: number;
    /** Already masked. Present only when ok is false. */
    error?: string;
}
export declare const DEFAULT_TIMEOUT_MS = 5000;
export declare const DEFAULT_DELAY_MS = 500;
/**
 * Throw this from a check when retrying cannot help (a model that does not
 * support tools, a 401 from a bad API key). The check fails at once instead
 * of burning its remaining attempts.
 */
export declare class FatalCheckError extends Error {
    constructor(message: string);
}
export declare class CheckTimeoutError extends Error {
    constructor(ms: number);
}
export declare function delayFor(policy: RetryPolicy, failedAttempt: number): number;
export declare function runCheck<E>(check: PreflightCheck<E>, env: E, mask?: (text: string) => string): Promise<CheckOutcome>;
export declare function runChecks<E>(checks: readonly PreflightCheck<E>[], env: E, mask?: (text: string) => string): Promise<CheckOutcome[]>;
