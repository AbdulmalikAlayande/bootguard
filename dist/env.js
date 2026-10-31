import { isBlank, isBootguardValidator } from "./validators.js";
/** Key names that are treated as secret even without `secret: true`. */
const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|_KEY$)/i;
export async function validateEnv(spec, read, extraSecretKeys = []) {
    const env = {};
    const problems = [];
    const secretValues = [];
    for (const key of Object.keys(spec)) {
        const schema = spec[key];
        let raw;
        try {
            raw = read(key);
        }
        catch (err) {
            problems.push({ key, kind: "missing", message: err instanceof Error ? err.message : String(err) });
            continue;
        }
        const value = isBlank(raw) ? undefined : raw;
        const isSecret = extraSecretKeys.includes(key) ||
            SECRET_KEY.test(key) ||
            (isBootguardValidator(schema) && schema.options.secret === true);
        if (isSecret && typeof value === "string")
            secretValues.push(value);
        let result;
        try {
            // Unlike T3 Env, async validation is allowed: start() is async anyway.
            result = await schema["~standard"].validate(value);
        }
        catch (err) {
            result = { issues: [{ message: err instanceof Error ? err.message : String(err) }] };
        }
        if (result.issues) {
            problems.push({
                key,
                kind: value === undefined ? "missing" : "invalid",
                message: result.issues.map((i) => i.message).join("; "),
            });
        }
        else {
            env[key] = result.value;
            // A secret supplied by a default (not the environment) must be masked too.
            if (isSecret && typeof result.value === "string" && result.value !== value) {
                secretValues.push(result.value);
            }
        }
    }
    return { env: Object.freeze(env), problems, secretValues };
}
