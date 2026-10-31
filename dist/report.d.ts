/**
 * Failure and status reports. Everything that reaches a log passes through
 * mask(), so a secret that leaks into an error message (a driver echoing its
 * connection string, say) is replaced before it is printed.
 */
import type { EnvProblem } from "./env.ts";
import type { CheckOutcome } from "./checks.ts";
export declare function createMasker(secretValues: readonly string[]): (text: string) => string;
export declare function formatDuration(ms: number): string;
export declare function formatEnvReport(problems: readonly EnvProblem[]): string;
export declare function formatChecks(outcomes: readonly CheckOutcome[]): string[];
export declare function formatCheckFailure(outcomes: readonly CheckOutcome[]): string;
export declare function formatReady(outcomes: readonly CheckOutcome[], durationMs: number, runtime: string): string;
