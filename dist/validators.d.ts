/**
 * Built-in env validators, modelled on Envalid's "object with a parse
 * function" design. Each validator also implements Standard Schema, so the
 * engine has a single code path for these and for Zod/Valibot/ArkType.
 *
 * Rule copied from Envalid: error messages never include the raw value,
 * because a connection string or token can contain a secret.
 */
import type { StandardSchemaV1 } from "./standard.ts";
export interface ValidatorOptions<T> {
    /** Value used when the variable is missing. Makes the variable optional. */
    default?: T;
    /** Allow the variable to be missing; its value is then `undefined`. */
    optional?: boolean;
    /** Mask this value wherever it appears in reports and check errors. */
    secret?: boolean;
    /** Restrict the parsed value to a fixed set. */
    choices?: readonly T[];
    /** Human description, shown when the variable is missing. */
    desc?: string;
}
export interface Validator<T> extends StandardSchemaV1<string | undefined, T> {
    readonly kind: string;
    readonly options: ValidatorOptions<unknown>;
}
/** Thrown inside a parse function to reject a value. */
export declare class InvalidValue extends Error {
}
export declare const MISSING = "is required but was not set";
/** True when a raw env value counts as "not set" (undefined, empty or whitespace). */
export declare const isBlank: (raw: unknown) => boolean;
export interface ValidatorFactory<T> {
    (options: ValidatorOptions<T> & {
        optional: true;
    }): Validator<T | undefined>;
    (options?: ValidatorOptions<T>): Validator<T>;
}
/** Create a validator from a parse function that returns the value or throws. */
export declare function makeValidator<T>(kind: string, parse: (raw: string) => T): ValidatorFactory<T>;
export declare const str: ValidatorFactory<string>;
export declare const num: ValidatorFactory<number>;
export declare const bool: ValidatorFactory<boolean>;
export declare const port: ValidatorFactory<number>;
export declare const url: ValidatorFactory<string>;
export declare const json: ValidatorFactory<unknown>;
export declare function isBootguardValidator(s: unknown): s is Validator<unknown>;
