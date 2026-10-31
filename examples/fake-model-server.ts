/**
 * A tiny OpenAI-compatible model server for tests and offline demos. It
 * imitates the failure modes of real local servers (Ollama, vLLM) without
 * downloading any weights. Runs on Node, Bun and Deno via node:http.
 */
import http from "node:http";

export interface FakeModelOptions {
  /** Models the server claims to have. */
  models?: string[];
  /** For this long after start, chat calls answer 503 "loading model". */
  loadingMs?: number;
  /** Whether the model supports tool calls. Default false (like gemma3 on Ollama). */
  tools?: boolean;
  /** Fixed port; 0 picks a free one. */
  port?: number;
  /** Imitate servers without a /models route (404). */
  noModelsRoute?: boolean;
  /** Imitate a reasoning model that returns empty content. */
  reasoning?: boolean;
  /** Imitate a model that wraps JSON in a ```json fence. */
  fencedJson?: boolean;
  /** Models the server can serve but does not list (like a hosted router). */
  unlisted?: string[];
}

export interface FakeModelServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFakeModelServer(opts: FakeModelOptions = {}): Promise<FakeModelServer> {
  const models = opts.models ?? ["gemma3:1b"];
  const startedAt = Date.now();

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const reply = (model: string, message: Record<string, unknown>) => ({
    id: "fake",
    object: "chat.completion",
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", ...message } }],
  });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models" && !opts.noModelsRoute) {
        return send(res, 200, { object: "list", data: models.map((id) => ({ id, object: "model" })) });
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        return send(res, 404, { error: { message: "not found" } });
      }
      const body = JSON.parse(raw || "{}");
      if (!models.includes(body.model) && !(opts.unlisted ?? []).includes(body.model)) {
        return send(res, 404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      }
      if (Date.now() - startedAt < (opts.loadingMs ?? 0)) {
        return send(res, 503, { error: { message: "loading model" } });
      }
      if (body.tools && !opts.tools) {
        return send(res, 400, { error: { message: `${body.model} does not support tools` } });
      }
      if (body.tools) {
        return send(res, 200, reply(body.model, {
          tool_calls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }],
        }));
      }
      if (body.response_format?.type === "json_object") {
        const ask = body.messages?.at(-1)?.content ?? "";
        const content = ask.startsWith("Classify")
          ? JSON.stringify({ note: "fake model", items: ask.split("\n").slice(1).map((line: string) => ({
              line, severity: /refused|97%/.test(line) ? "critical" : "ok" })) }, null, 2)
          : '{"ok": true}';
        return send(res, 200, reply(body.model, { content: opts.fencedJson ? "```json\n" + content + "\n```" : content }));
      }
      const system = body.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
      if (system.includes("on-call engineer")) {
        const report: string = body.messages?.at(-1)?.content ?? "";
        const content = /does not support tools/.test(report)
          ? "- (fake model) The agent needs tool calling, but this model has no tool support.\n- Switch MODEL_NAME to a model that supports tools, e.g. `ollama pull qwen2.5:1.5b`.\n- Or, if the agent can work with structured output, set AGENT_NEEDS=json."
          : "- (fake model) A required dependency named in the report is not reachable.\n- Start it, or fix its URL in your environment, then restart.";
        return send(res, 200, reply(body.model, { content }));
      }
      const last = body.messages?.at(-1)?.content ?? "";
      if (opts.reasoning) {
        return send(res, 200, reply(body.model, { content: "", reasoning: "thinking..." }));
      }
      return send(res, 200, reply(body.model, { content: /READY/.test(last) ? "READY" : `echo: ${last}` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
