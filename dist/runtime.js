/**
 * Runtime adapter: the only file that knows which JavaScript runtime it is in.
 *
 * Detection order follows @cross/runtime: Deno and Bun are checked before
 * Node because both also expose a `process` object, so checking Node first
 * would mislabel them.
 */
/** The runtime refused to read a variable (Deno without --allow-env). */
export class EnvAccessError extends Error {
}
// deno-lint-ignore no-explicit-any
const g = globalThis;
export function detectRuntime() {
    if (typeof g.Deno === "object" && g.Deno !== null)
        return "deno";
    if (typeof g.Bun === "object" && g.Bun !== null)
        return "bun";
    if (g.navigator?.userAgent === "Cloudflare-Workers")
        return "workerd";
    if (typeof g.process === "object" && g.process?.versions?.node)
        return "node";
    return "unknown";
}
function processEnv() {
    return (g.process?.env ?? {});
}
export function createRuntimeAdapter(name = detectRuntime()) {
    switch (name) {
        case "deno":
            return {
                name,
                // Per-key reads work with narrow permissions (--allow-env=KEY1,KEY2),
                // whereas Deno.env.toObject() needs blanket --allow-env.
                readEnv(key) {
                    try {
                        return g.Deno.env.get(key);
                    }
                    catch {
                        // Say why, instead of claiming the variable is unset.
                        throw new EnvAccessError(`cannot be read: run Deno with --allow-env=${key}`);
                    }
                },
                defaultFailureMode: "exit",
                exit(code) {
                    g.Deno.exit(code);
                    throw new Error("unreachable");
                },
            };
        case "bun":
            return {
                name,
                readEnv: (key) => (g.Bun.env ?? processEnv())[key],
                defaultFailureMode: "exit",
                exit(code) {
                    g.process.exit(code);
                    throw new Error("unreachable");
                },
            };
        case "node":
            return {
                name,
                readEnv: (key) => processEnv()[key],
                defaultFailureMode: "exit",
                exit(code) {
                    g.process.exit(code);
                    throw new Error("unreachable");
                },
            };
        default:
            // Workers and unknown hosts: there is no process to exit, so failing
            // means throwing. Workers expose process.env only under nodejs_compat;
            // otherwise pass `source: env` from the fetch handler.
            return {
                name,
                readEnv: (key) => processEnv()[key],
                defaultFailureMode: "throw",
                exit() {
                    throw new Error(`bootguard: cannot exit a process on runtime "${name}"`);
                },
            };
    }
}
