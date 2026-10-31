import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BootError, createBoot, FatalCheckError, str, url } from "../src/index.ts";
import { ghostReport, modelCheck } from "../src/ai.ts";
import { startFakeModelServer } from "../examples/fake-model-server.ts";

const quiet = { onFailure: "throw" as const, logger: false as const };
const fast = { retry: { attempts: 4, delayMs: 20 }, timeoutMs: 2_000 };

async function bootError(p: Promise<unknown>): Promise<BootError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof BootError, String(err));
    return err;
  }
  throw new Error("expected boot to fail");
}

describe("modelCheck", () => {
  it("passes when the model is present, answers and has the capability", async () => {
    const srv = await startFakeModelServer();
    try {
      const { status } = await createBoot(quiet)
        .check(modelCheck({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, { ...fast, requires: ["json"] }))
        .start();
      assert.equal(status.state, "ready");
    } finally {
      await srv.close();
    }
  });

  it("reads the endpoint from the validated env", async () => {
    const srv = await startFakeModelServer();
    try {
      await createBoot({ ...quiet, source: { MODEL_URL: srv.baseUrl, MODEL: "gemma3:1b" }, env: { MODEL_URL: url(), MODEL: str() } })
        .check(modelCheck((env) => ({ baseUrl: env.MODEL_URL, model: env.MODEL }), fast))
        .start();
    } finally {
      await srv.close();
    }
  });

  it("retries an unreachable server, then fails", async () => {
    const err = await bootError(
      createBoot(quiet).check(modelCheck({ baseUrl: "http://127.0.0.1:9/v1", model: "m" }, fast)).start(),
    );
    assert.equal(err.status.checks[0].attempts, 4);
    assert.match(err.status.checks[0].error!, /^server: cannot reach/);
  });

  it("fails at once when the model is not pulled (no pointless retries)", async () => {
    const srv = await startFakeModelServer({ models: ["llama3:8b"] });
    try {
      const err = await bootError(
        createBoot(quiet).check(modelCheck({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, fast)).start(),
      );
      assert.equal(err.status.checks[0].attempts, 1);
      assert.match(err.status.checks[0].error!, /model "gemma3:1b" is not on this server \(has: llama3:8b\)/);
    } finally {
      await srv.close();
    }
  });

  it("retries while weights load, then becomes ready", async () => {
    const srv = await startFakeModelServer({ loadingMs: 50 });
    try {
      const { status } = await createBoot(quiet)
        .check(modelCheck({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, fast))
        .start();
      assert.equal(status.state, "ready");
      assert.ok(status.checks[0].attempts > 1, "should have retried while loading");
    } finally {
      await srv.close();
    }
  });

  it("fails at once when a required capability is missing", async () => {
    const srv = await startFakeModelServer({ tools: false });
    try {
      const err = await bootError(
        createBoot(quiet)
          .check(modelCheck({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, { ...fast, requires: ["tools"] }))
          .start(),
      );
      assert.equal(err.status.checks[0].attempts, 1);
      assert.match(err.status.checks[0].error!, /tools capability: HTTP 400 .*does not support tools/);
    } finally {
      await srv.close();
    }
  });

  it("passes the tools capability when the model supports it", async () => {
    const srv = await startFakeModelServer({ tools: true });
    try {
      await createBoot(quiet)
        .check(modelCheck({ baseUrl: srv.baseUrl, model: "gemma3:1b" }, { ...fast, requires: ["tools"] }))
        .start();
    } finally {
      await srv.close();
    }
  });
});

describe("FatalCheckError", () => {
  it("stops retries immediately", async () => {
    let calls = 0;
    const err = await bootError(
      createBoot(quiet)
        .check({ name: "x", retry: { attempts: 5, delayMs: 1 }, run: () => { calls++; throw new FatalCheckError("no"); } })
        .start(),
    );
    assert.equal(calls, 1);
    assert.equal(err.status.checks[0].attempts, 1);
  });
});

describe("ghostReport", () => {
  it("prints the plain report first, then the model's explanation", async () => {
    const srv = await startFakeModelServer();
    const out: string[] = [];
    try {
      const ep = { baseUrl: srv.baseUrl, model: "gemma3:1b" };
      await bootError(
        createBoot({ onFailure: "throw", logger: { info() {}, error: (m) => out.push(m) }, onFailed: ghostReport(ep, { print: (t) => out.push(t) }) })
          .check(modelCheck(ep, fast))
          .check({ name: "database", run: () => { throw new Error("ECONNREFUSED"); } })
          .start(),
      );
      assert.equal(out.length, 2);
      assert.match(out[0], /boot failed/);
      assert.match(out[1], /ghost report \(explained by gemma3:1b, running locally\)/);
    } finally {
      await srv.close();
    }
  });

  it("still explains when the model answers but lacks a capability", async () => {
    const srv = await startFakeModelServer({ tools: false });
    const out: string[] = [];
    try {
      const ep = { baseUrl: srv.baseUrl, model: "gemma3:1b" };
      await bootError(
        createBoot({ ...quiet, onFailed: ghostReport(ep, { print: (t) => out.push(t) }) })
          .check(modelCheck(ep, { ...fast, requires: ["tools"] }))
          .start(),
      );
      assert.match(out[0], /ghost report \(explained/);
    } finally {
      await srv.close();
    }
  });

  it("skips itself when the model is the thing that is down", async () => {
    const out: string[] = [];
    const ep = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
    await bootError(
      createBoot({ ...quiet, onFailed: ghostReport(ep, { print: (t) => out.push(t) }) })
        .check(modelCheck(ep, { ...fast, retry: { attempts: 1 } }))
        .start(),
    );
    assert.match(out[0], /skipped: the model is the thing that failed/);
  });

  it("a hanging explainer cannot block the failure", async () => {
    const t0 = performance.now();
    await bootError(
      createBoot({ ...quiet, onFailed: () => new Promise(() => {}), onFailedTimeoutMs: 50 })
        .check({ name: "x", run: () => { throw new Error("down"); } })
        .start(),
    );
    assert.ok(performance.now() - t0 < 1_000);
  });
});
