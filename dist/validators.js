/** Thrown inside a parse function to reject a value. */
export class InvalidValue extends Error {
}
export const MISSING = "is required but was not set";
/** True when a raw env value counts as "not set" (undefined, empty or whitespace). */
export const isBlank = (raw) => raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
/** Create a validator from a parse function that returns the value or throws. */
export function makeValidator(kind, parse) {
    const factory = (options = {}) => {
        const validate = (raw) => {
            if (isBlank(raw)) {
                if (options.default !== undefined)
                    return { value: options.default };
                if (options.optional)
                    return { value: undefined };
                return { issues: [{ message: options.desc ? `${MISSING} (${options.desc})` : MISSING }] };
            }
            let value;
            try {
                value = parse(String(raw));
            }
            catch (err) {
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
            options: options,
            "~standard": { version: 1, vendor: "bootguard", validate },
        };
    };
    return factory;
}
export const str = makeValidator("string", (raw) => raw);
export const num = makeValidator("number", (raw) => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n))
        throw new InvalidValue("is not a valid number");
    return n;
});
export const bool = makeValidator("boolean", (raw) => {
    const v = raw.trim().toLowerCase();
    if (["true", "t", "yes", "on", "1"].includes(v))
        return true;
    if (["false", "f", "no", "off", "0"].includes(v))
        return false;
    throw new InvalidValue("is not a valid boolean (use true/false, yes/no, on/off, 1/0)");
});
export const port = makeValidator("port", (raw) => {
    const n = Number(raw);
    // Round-trip check (from Envalid) rejects "080", "3000abc" and " 80".
    if (!Number.isInteger(n) || String(n) !== raw || n < 1 || n > 65535) {
        throw new InvalidValue("is not a valid port (1-65535)");
    }
    return n;
});
export const url = makeValidator("url", (raw) => {
    try {
        new URL(raw);
    }
    catch {
        throw new InvalidValue("is not a valid URL");
    }
    return raw;
});
export const json = makeValidator("json", (raw) => {
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new InvalidValue("is not valid JSON");
    }
});
export function isBootguardValidator(s) {
    return (typeof s === "object" &&
        s !== null &&
        s["~standard"]?.vendor === "bootguard");
}
