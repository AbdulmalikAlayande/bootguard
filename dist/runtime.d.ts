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
/** The runtime refused to read a variable (Deno without --allow-env). */
export declare class EnvAccessError extends Error {
}
export declare function detectRuntime(): RuntimeName;
export declare function createRuntimeAdapter(name?: RuntimeName): RuntimeAdapter;
