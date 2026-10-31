/**
 * Phase 1: env validation. Every variable is checked and every problem is
 * collected before anything is reported (Envalid's pattern), so one boot
 * shows all config mistakes at once.
 */
import type { StandardSchemaV1, InferOutput } from "./standard.ts";
export type EnvSpec = Record<string, StandardSchemaV1>;
export type EnvOf<S extends EnvSpec> = {
    readonly [K in keyof S]: InferOutput<S[K]>;
};
export interface EnvProblem {
    key: string;
    kind: "missing" | "invalid";
    message: string;
}
export interface EnvResult<S extends EnvSpec> {
    env: EnvOf<S>;
    problems: EnvProblem[];
    /** Values that must be masked in any output. */
    secretValues: string[];
}
export declare function validateEnv<S extends EnvSpec>(spec: S, read: (key: string) => string | undefined, extraSecretKeys?: readonly string[]): Promise<EnvResult<S>>;
