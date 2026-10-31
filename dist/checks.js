/**
 * Phase 2: preflight checks. All checks run in parallel; each one has its
 * own retry policy and a per-attempt timeout, so no single check can hold
 * the boot forever. A check never rejects here: every result, pass or fail,
 * is collected so the report can show all of them at once.
 */
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
/**
 * Throw this from a check when retrying cannot help (a model that does not
 * support tools, a 401 from a bad API key). The check fails at once instead
 * of burning its remaining attempts.
 */
export class FatalCheckError extends Error {
    constructor(message) {
        super(message);
        this.name = "FatalCheckError";
    }
}
export class CheckTimeoutError extends Error {
    constructor(ms) {
        super(`timed out after ${ms}ms`);
        this.name = "CheckTimeoutError";
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errorMessage(err) {
    if (err instanceof Error)
        return err.message || err.name;
    return String(err);
}
async function attemptWithTimeout(fn, ms) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new CheckTimeoutError(ms);
            controller.abort(err);
            reject(err);
        }, ms);
    });
    try {
        await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
export function delayFor(policy, failedAttempt) {
    const base = policy.delayMs ?? DEFAULT_DELAY_MS;
    if (!policy.backoff)
        return base;
    return Math.min(base * 2 ** (failedAttempt - 1), policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
}
export async function runCheck(check, env, mask = (t) => t) {
    const required = check.required ?? true;
    const attempts = Math.max(1, check.retry?.attempts ?? 1);
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = performance.now();
    let lastError;
    let tried = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        tried = attempt;
        try {
            await attemptWithTimeout((signal) => check.run({ env, signal, attempt }), timeoutMs);
            return { name: check.name, required, ok: true, attempts: attempt, durationMs: performance.now() - started };
        }
        catch (err) {
            lastError = err;
            if (err instanceof FatalCheckError)
                break; // retrying cannot fix this
            if (attempt < attempts)
                await sleep(delayFor(check.retry, attempt));
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
export function runChecks(checks, env, mask) {
    return Promise.all(checks.map((c) => runCheck(c, env, mask)));
}
