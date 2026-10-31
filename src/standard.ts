/**
 * Standard Schema V1 interface (types only).
 *
 * Copied from the Standard Schema specification (https://standardschema.dev),
 * which asks integrators to copy this file rather than depend on a package.
 * Any validator implementing it (Zod 3.24+, Valibot 1, ArkType 2, and
 * bootguard's own built-in validators) can be used in an env spec.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: StandardTypes<Input, Output> | undefined;
}

export type StandardResult<Output> = StandardSuccess<Output> | StandardFailure;

export interface StandardSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardFailure {
  readonly issues: ReadonlyArray<StandardIssue>;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export interface StandardTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];
