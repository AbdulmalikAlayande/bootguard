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

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Throw this from a check when retrying cannot help (a model that does not
 * support tools, a 401 from a bad API key). The check fails at once instead
 * of burning its remaining attempts.
 */
export class FatalCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalCheckError";
  }
}

export class CheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "CheckTimeoutError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

async function attemptWithTimeout(
  fn: (signal: AbortSignal) => unknown,
  ms: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new CheckTimeoutError(ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function delayFor(policy: RetryPolicy, failedAttempt: number): number {
  const base = policy.delayMs ?? DEFAULT_DELAY_MS;
  if (!policy.backoff) return base;
  return Math.min(base * 2 ** (failedAttempt - 1), policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
}

export async function runCheck<E>(
  check: PreflightCheck<E>,
  env: E,
  mask: (text: string) => string = (t) => t,
): Promise<CheckOutcome> {
  const required = check.required ?? true;
  const attempts = Math.max(1, check.retry?.attempts ?? 1);
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  let lastError: unknown;
  let tried = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    tried = attempt;
    try {
      await attemptWithTimeout((signal) => check.run({ env, signal, attempt }), timeoutMs);
      return { name: check.name, required, ok: true, attempts: attempt, durationMs: performance.now() - started };
    } catch (err) {
      lastError = err;
      if (err instanceof FatalCheckError) break; // retrying cannot fix this
      if (attempt < attempts) await sleep(delayFor(check.retry!, attempt));
    }
  }

  return {
    name: check.name,
    required,
    ok: false,
    attempts: tried,
    durationMs: performance.now() - started,
    error: mask(errorMessage(lastError)),
  };
}

export function runChecks<E>(
  checks: readonly PreflightCheck<E>[],
  env: E,
  mask?: (text: string) => string,
): Promise<CheckOutcome[]> {
  return Promise.all(checks.map((c) => runCheck(c, env, mask)));
}
