/**
 * Failure and status reports. Everything that reaches a log passes through
 * mask(), so a secret that leaks into an error message (a driver echoing its
 * connection string, say) is replaced before it is printed.
 */
import type { EnvProblem } from "./env.ts";
import type { CheckOutcome } from "./checks.ts";

const MASK = "****";
// scheme://user:password@host  ->  scheme://user:****@host
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@/\s]+)(@)/gi;

export function createMasker(secretValues: readonly string[]): (text: string) => string {
  // Longest first, so a secret containing another secret is fully masked.
  // Very short values are skipped: masking "1" would garble the whole report.
  const secrets = [...new Set(secretValues)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text.replace(URL_CREDENTIALS, `$1${MASK}$3`);
    for (const s of secrets) out = out.split(s).join(MASK);
    return out;
  };
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function formatEnvReport(problems: readonly EnvProblem[]): string {
  const width = Math.max(...problems.map((p) => p.key.length)) + 3;
  const section = (title: string, kind: EnvProblem["kind"]) => {
    const rows = problems.filter((p) => p.kind === kind);
    if (!rows.length) return [];
    return [`  ${title}`, ...rows.map((p) => `    ${pad(p.key, width)}${p.message}`)];
  };
  const n = problems.length;
  return [
    `bootguard ✖ boot failed: environment is invalid (${n} problem${n === 1 ? "" : "s"})`,
    "",
    ...section("Missing", "missing"),
    ...section("Invalid", "invalid"),
    "",
    "  No checks were run. Fix the environment and restart.",
  ].join("\n");
}

export function formatChecks(outcomes: readonly CheckOutcome[]): string[] {
  const width = Math.max(...outcomes.map((o) => o.name.length)) + 3;
  return outcomes.map((o) => {
    const icon = o.ok ? "✔" : o.required ? "✖" : "⚠";
    const meta = [
      o.required ? "required" : "optional",
      `${o.attempts} attempt${o.attempts === 1 ? "" : "s"}`,
      formatDuration(o.durationMs),
    ];
    if (o.error) meta.push(o.error);
    return `  ${icon} ${pad(o.name, width)}${meta.join(" · ")}`;
  });
}

export function formatCheckFailure(outcomes: readonly CheckOutcome[]): string {
  const failed = outcomes.filter((o) => !o.ok && o.required).length;
  return [
    `bootguard ✖ boot failed: ${failed} required check${failed === 1 ? "" : "s"} did not pass`,
    "",
    ...formatChecks(outcomes),
  ].join("\n");
}

export function formatReady(
  outcomes: readonly CheckOutcome[],
  durationMs: number,
  runtime: string,
): string {
  const degraded = outcomes.some((o) => !o.ok);
  const head = degraded
    ? `bootguard ⚠ ready (degraded) in ${formatDuration(durationMs)} on ${runtime}`
    : `bootguard ✔ ready in ${formatDuration(durationMs)} on ${runtime}`;
  if (!outcomes.length) return `${head} (no checks registered)`;
  return [head, ...formatChecks(outcomes)].join("\n");
}
