/**
 * Built-in env validators, modelled on Envalid's "object with a parse
 * function" design. Each validator also implements Standard Schema, so the
 * engine has a single code path for these and for Zod/Valibot/ArkType.
 *
 * Rule copied from Envalid: error messages never include the raw value,
 * because a connection string or token can contain a secret.
 */
import type { StandardSchemaV1, StandardResult } from "./standard.ts";

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
export class InvalidValue extends Error {}

export const MISSING = "is required but was not set";

/** True when a raw env value counts as "not set" (undefined, empty or whitespace). */
export const isBlank = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");

export interface ValidatorFactory<T> {
  (options: ValidatorOptions<T> & { optional: true }): Validator<T | undefined>;
  (options?: ValidatorOptions<T>): Validator<T>;
}

/** Create a validator from a parse function that returns the value or throws. */
export function makeValidator<T>(
  kind: string,
  parse: (raw: string) => T,
): ValidatorFactory<T> {
  const factory = (options: ValidatorOptions<T> = {}): Validator<T> => {
    const validate = (raw: unknown): StandardResult<T> => {
      if (isBlank(raw)) {
        if (options.default !== undefined) return { value: options.default };
        if (options.optional) return { value: undefined as T };
        return { issues: [{ message: options.desc ? `${MISSING} (${options.desc})` : MISSING }] };
      }
      let value: T;
      try {
        value = parse(String(raw));
      } catch (err) {
        const message = err instanceof InvalidValue ? err.message : `is not a valid ${kind}`;
        return { issues: [{ message }] };
      }
      if (options.choices && !options.choices.includes(value)) {
        return { issues: [{ message: `must be one of: ${options.choices.join(", ")}` }] };
      }
      return { value };
    };
    return {
      kind,
      options: options as ValidatorOptions<unknown>,
      "~standard": { version: 1, vendor: "bootguard", validate },
    };
  };
  return factory as ValidatorFactory<T>;
}

export const str = makeValidator<string>("string", (raw) => raw);

export const num = makeValidator<number>("number", (raw) => {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) throw new InvalidValue("is not a valid number");
  return n;
});

export const bool = makeValidator<boolean>("boolean", (raw) => {
  const v = raw.trim().toLowerCase();
  if (["true", "t", "yes", "on", "1"].includes(v)) return true;
  if (["false", "f", "no", "off", "0"].includes(v)) return false;
  throw new InvalidValue("is not a valid boolean (use true/false, yes/no, on/off, 1/0)");
});

export const port = makeValidator<number>("port", (raw) => {
  const n = Number(raw);
  // Round-trip check (from Envalid) rejects "080", "3000abc" and " 80".
  if (!Number.isInteger(n) || String(n) !== raw || n < 1 || n > 65535) {
    throw new InvalidValue("is not a valid port (1-65535)");
  }
  return n;
});

export const url = makeValidator<string>("url", (raw) => {
  try {
    new URL(raw);
  } catch {
    throw new InvalidValue("is not a valid URL");
  }
  return raw;
});

export const json = makeValidator<unknown>("json", (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidValue("is not valid JSON");
  }
});

export function isBootguardValidator(s: unknown): s is Validator<unknown> {
  return (
    typeof s === "object" &&
    s !== null &&
    (s as Validator<unknown>)["~standard"]?.vendor === "bootguard"
  );
}
