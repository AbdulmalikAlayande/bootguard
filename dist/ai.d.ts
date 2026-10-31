/**
 * bootguard/ai: preflight for agents that run on open-weight models.
 *
 * A model server can be up, answer its health route, and still have no
 * working model behind it: the model was never pulled, its weights are still
 * loading, or it cannot do what the agent needs (tool calls, JSON). That
 * agent is a ghost in the machine. modelCheck() catches every one of those
 * before the agent accepts work, against any OpenAI-compatible server
 * (Ollama, llama.cpp server, vLLM, LM Studio, and hosted endpoints).
 *
 * ghostReport() is the other half: when boot fails, a local open-weight
 * model reads bootguard's (already masked) report and explains the fix in
 * plain English. The deterministic report is always printed first.
 */
import { type PreflightCheck } from "./checks.ts";
import type { BootStatus } from "./boot.ts";
export interface ModelEndpoint {
    /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 for Ollama. */
    baseUrl: string;
    /** Model id as the server knows it, e.g. gemma3:1b. */
    model: string;
    /** Sent as a Bearer token when set. Local servers usually ignore it. */
    apiKey?: string;
}
export type Capability = "json" | "tools";
export interface ModelCheckOptions {
    /** Check name in reports. Default "model". */
    name?: string;
    /** Capabilities the agent depends on. Each one is proven with a real call. */
    requires?: readonly Capability[];
    /** Smoke prompt. Default asks for a one-word reply. */
    prompt?: string;
    /** Pattern the smoke reply must match. Default: any non-empty reply. */
    expect?: RegExp;
    /** Default true. */
    required?: boolean;
    /** Default: 6 attempts, backoff from 1s. Covers weights loading. */
    retry?: PreflightCheck<unknown>["retry"];
    /** Per attempt. Default 60s, because a cold model can take a while. */
    timeoutMs?: number;
}
type EndpointSource<E> = ModelEndpoint | ((env: E) => ModelEndpoint);
/**
 * One check that proves the model is genuinely usable, in order:
 * server reachable, model present, model answers, required capabilities work.
 * Steps run inside one check because each depends on the previous one.
 */
export declare function modelCheck<E = unknown>(endpoint: EndpointSource<E>, options?: ModelCheckOptions): PreflightCheck<E>;
export interface GhostReportOptions {
    /** Where the explanation is printed. Default console.error. */
    print?: (text: string) => void;
    /** Max tokens for the explanation. Default 300. */
    maxTokens?: number;
    /** Name of the check that probes this same model, so a dead model is not asked to explain itself. Default "model". */
    modelCheckName?: string;
    /** Give up on the explanation after this long. Default 25s. */
    timeoutMs?: number;
}
/**
 * Returns an onFailed hook for createBoot(). It asks a local open-weight
 * model to explain the failure report. It skips itself when the model is the
 * thing that failed (a dead model cannot explain itself) and stays silent on
 * any error, so the deterministic report is never at risk.
 */
export declare function ghostReport(endpoint: ModelEndpoint, options?: GhostReportOptions): ({ report, status }: {
    report: string;
    status: BootStatus;
}) => Promise<void>;
export {};
