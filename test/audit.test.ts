/**
 * Tests from the self-audit. Five are regressions that failed (or hung) on the
 * pre-audit code: reasoning models, missing /models route, fenced JSON, secrets
 * from defaults, and the ghost report timeout. The rest guard behaviour that
 * was already correct.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BootError, createBoot, str } from "../src/index.ts";
import { ghostReport, modelCheck } from "../src/ai.ts";
import { startFakeModelServer } from "../examples/fake-model-server.ts";

const quiet = { onFailure: "throw" as const, logger: false as const };
const fast = { retry: { attempts: 3, delayMs: 10 }, timeoutMs: 2_000 };

async function bootError(p: Promise<unknown>): Promise<BootError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof BootError, String(err));
    return err;
  }
  throw new Error("expected boot to fail");
}

async function withServer(opts: Parameters<typeof startFakeModelServer>[0], fn: (url: string) => Promise<void>) {
  const srv = await startFakeModelServer(opts);
  try {
    await fn(srv.baseUrl);
  } finally {
    await srv.close();
  }
}

describe("audit: model servers that differ from Ollama", () => {
  it("accepts a reasoning model that returns empty content", () =>
    withServer({ reasoning: true }, async (baseUrl) => {
      const { status } = await createBoot(quiet).check(modelCheck({ baseUrl, model: "gemma3:1b" }, fast)).start();
      assert.equal(status.checks[0].attempts, 1);
    }));

  it("works with servers that have no /models route", () =>
    withServer({ noModelsRoute: true }, async (baseUrl) => {
      await createBoot(quiet).check(modelCheck({ baseUrl, model: "gemma3:1b" }, fast)).start();
    }));

  it("without /models, a missing model is still caught by the chat call", () =>
    withServer({ noModelsRoute: true }, async (baseUrl) => {
      const err = await bootError(createBoot(quiet).check(modelCheck({ baseUrl, model: "nope" }, fast)).start());
      assert.equal(err.status.checks[0].attempts, 1);
      assert.match(err.status.checks[0].error!, /HTTP 404 .*not found/);
    }));

  it("accepts JSON wrapped in a markdown fence", () =>
    withServer({ fencedJson: true }, async (baseUrl) => {
      await createBoot(quiet).check(modelCheck({ baseUrl, model: "gemma3:1b" }, { ...fast, requires: ["json"] })).start();
    }));

  it("matches an untagged model name against :latest", () =>
    withServer({ models: ["gemma3:latest"] }, async (baseUrl) => {
      // the chat call uses the untagged name, which the fake does not list, so only check presence logic:
      const err = await bootError(createBoot(quiet).check(modelCheck({ baseUrl, model: "gemma3" }, fast)).start());
      assert.doesNotMatch(err.status.checks[0].error!, /is not on this server/);
    }));
});

describe("audit: hosted routers (Hugging Face style)", () => {
  it("serves a model it does not list, e.g. org/model:provider", () =>
    withServer({ models: ["meta-llama/Llama-3.1-8B-Instruct"], unlisted: ["meta-llama/Llama-3.1-8B-Instruct:cerebras", "x/unlisted"] }, async (baseUrl) => {
      await createBoot(quiet).check(modelCheck({ baseUrl, model: "meta-llama/Llama-3.1-8B-Instruct:cerebras" }, fast)).start();
      await createBoot(quiet).check(modelCheck({ baseUrl, model: "x/unlisted" }, fast)).start();
    }));

  it("truncates a huge model list in the error", () =>
    withServer({ models: Array.from({ length: 300 }, (_, i) => `org/model-${i}`) }, async (baseUrl) => {
      const err = await bootError(createBoot(quiet).check(modelCheck({ baseUrl, model: "org/missing" }, fast)).start());
      assert.match(err.status.checks[0].error!, /is not on this server \(has: org\/model-0, .*… 295 more\)/);
      assert.ok(err.report.length < 400, "report stays readable");
    }));

  it("labels a localhost explainer as running locally", async () => {
    const out: string[] = [];
    const srv = await startFakeModelServer();
    try {
      await ghostReport({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, { print: (t) => out.push(t) })({
        report: "bootguard ✖ boot failed", status: { checks: [] } as never,
      });
      assert.match(out[0], /running locally/);
    } finally {
      await srv.close();
    }
  });
});

describe("audit: secrets", () => {
  it("masks a secret that came from a default value", async () => {
    const err = await bootError(
      createBoot({ ...quiet, source: {}, env: { SESSION_SECRET: str({ default: "dev-default-secret" }) } })
        .check({ name: "x", run: ({ env }) => { throw new Error(`bad ${env.SESSION_SECRET}`); } })
        .start(),
    );
    assert.ok(!err.report.includes("dev-default-secret"));
  });

  it("the ghost report only ever sees the masked report", () =>
    withServer({}, async (baseUrl) => {
      let seen = "";
      await bootError(
        createBoot({
          ...quiet,
          source: { DB_PASSWORD: "hunter2-very-secret" },
          env: { DB_PASSWORD: str() },
          onFailed: ({ report }) => { seen = report; return ghostReport({ baseUrl, model: "gemma3:1b" }, { print: () => {} })({ report, status: {} as never }); },
        })
          .check({ name: "db", run: ({ env }) => { throw new Error(`login failed: ${env.DB_PASSWORD}`); } })
          .start(),
      );
      assert.ok(seen.length > 0 && !seen.includes("hunter2-very-secret"));
    }));
});

describe("audit: robustness", () => {
  it("a validator that throws is reported, not crashed on", async () => {
    const throws = { "~standard": { version: 1 as const, vendor: "x", validate: () => { throw new Error("validator bug"); } } };
    const err = await bootError(createBoot({ ...quiet, source: { A: "1" }, env: { A: throws } }).start());
    assert.equal(err.status.envProblems[0].message, "validator bug");
  });

  it("a check that throws a non-Error value is reported", async () => {
    const err = await bootError(createBoot(quiet).check({ name: "x", run: () => { throw "plain string"; } }).start());
    assert.equal(err.status.checks[0].error, "plain string");
  });

  it("ghost report gives up after its own timeout", async () => {
    const http = await import("node:http");
    const hang = http.createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const { port } = hang.address() as { port: number };
    try {
      const t0 = performance.now();
      await ghostReport({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m" }, { timeoutMs: 100, print: () => {} })({
        report: "x",
        status: { checks: [] } as never,
      });
      assert.ok(performance.now() - t0 < 2_000);
    } finally {
      hang.closeAllConnections?.();
      hang.close();
    }
  });
});
