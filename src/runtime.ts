/**
 * Runtime adapter: the only file that knows which JavaScript runtime it is in.
 *
 * Detection order follows @cross/runtime: Deno and Bun are checked before
 * Node because both also expose a `process` object, so checking Node first
 * would mislabel them.
 */

export type RuntimeName = "deno" | "bun" | "node" | "workerd" | "unknown";

/** How a failed boot ends: kill the process, or throw an error the host can see. */
export type FailureMode = "exit" | "throw";

export interface RuntimeAdapter {
  readonly name: RuntimeName;
  /** Read one environment variable. Missing or unreadable values are `undefined`. */
  readEnv(key: string): string | undefined;
  /** Default failure mode: `exit` where a process exists, `throw` otherwise. */
  readonly defaultFailureMode: FailureMode;
  /** End the process. Only called when the failure mode is `exit`. */
  exit(code: number): never;
}

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

export function detectRuntime(): RuntimeName {
  if (typeof g.Deno === "object" && g.Deno !== null) return "deno";
  if (typeof g.Bun === "object" && g.Bun !== null) return "bun";
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
  if (typeof g.process === "object" && g.process?.versions?.node) return "node";
  return "unknown";
}

function processEnv(): Record<string, string | undefined> {
  return (g.process?.env ?? {}) as Record<string, string | undefined>;
}

export function createRuntimeAdapter(name: RuntimeName = detectRuntime()): RuntimeAdapter {
  switch (name) {
    case "deno":
      return {
        name,
        // Per-key reads work with narrow permissions (--allow-env=KEY1,KEY2),
        // whereas Deno.env.toObject() needs blanket --allow-env.
        readEnv(key) {
          try {
            return g.Deno.env.get(key);
          } catch {
            return undefined; // permission denied is reported as "missing"
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
