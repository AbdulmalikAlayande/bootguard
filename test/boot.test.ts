import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BootError,
  bool,
  createBoot,
  detectRuntime,
  num,
  port,
  str,
  url,
  type StandardSchemaV1,
} from "../src/index.ts";
import { delayFor } from "../src/checks.ts";
import { createMasker } from "../src/report.ts";

const quiet = { onFailure: "throw" as const, logger: false as const };

async function bootError(promise: Promise<unknown>): Promise<BootError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof BootError, `expected BootError, got ${err}`);
    return err;
  }
  throw new Error("expected boot to fail");
}

describe("validators", () => {
  const ok = (v: StandardSchemaV1, raw: string | undefined) =>
    v["~standard"].validate(raw) as { value?: unknown; issues?: { message: string }[] };

  it("port rejects values that do not round-trip", () => {
    assert.equal(ok(port(), "3000").value, 3000);
    assert.ok(ok(port(), "080").issues);
    assert.ok(ok(port(), "70000").issues);
    assert.ok(ok(port(), "3000abc").issues);
  });

  it("bool accepts the common spellings", () => {
    for (const t of ["true", "YES", "on", "1"]) assert.equal(ok(bool(), t).value, true);
    for (const f of ["false", "no", "OFF", "0"]) assert.equal(ok(bool(), f).value, false);
    assert.ok(ok(bool(), "maybe").issues);
  });

  it("url errors never echo the raw value", () => {
    const res = ok(url(), "db.internal secretpass");
    assert.ok(res.issues);
    assert.ok(!res.issues![0].message.includes("secretpass"));
  });

  it("treats blank as missing and applies default / optional", () => {
    assert.equal(ok(num({ default: 5 }), "   ").value, 5);
    assert.equal(ok(str({ optional: true }), undefined).value, undefined);
    assert.ok(ok(str(), "").issues);
  });
});

describe("env phase", () => {
  it("collects every problem and runs no checks", async () => {
    let checkRan = false;
    const boot = createBoot({
      ...quiet,
      source: { PORT: "nope", DATABASE_URL: "not a url" },
      env: { PORT: port(), DATABASE_URL: url(), SESSION_SECRET: str() },
    }).check({ name: "db", run: () => { checkRan = true; } });

    const err = await bootError(boot.start());
    assert.equal(checkRan, false);
    assert.deepEqual(
      err.status.envProblems.map((p) => [p.key, p.kind]),
      [["PORT", "invalid"], ["DATABASE_URL", "invalid"], ["SESSION_SECRET", "missing"]],
    );
    assert.match(err.report, /Missing[\s\S]*SESSION_SECRET/);
    assert.equal(boot.status().state, "failed");
  });

  it("accepts any Standard Schema validator, including async ones", async () => {
    const upper: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (v) =>
          typeof v === "string" && v === v.toUpperCase()
            ? { value: v }
            : { issues: [{ message: "must be upper case" }] },
      },
    };
    const good = await createBoot({ ...quiet, source: { REGION: "EU" }, env: { REGION: upper } }).start();
    assert.equal(good.env.REGION, "EU");
    const bad = await bootError(createBoot({ ...quiet, source: { REGION: "eu" }, env: { REGION: upper } }).start());
    assert.equal(bad.status.envProblems[0].message, "must be upper case");
  });

  it("passes the typed env into checks", async () => {
    let seen: number | undefined;
    await createBoot({ ...quiet, source: { PORT: "8080" }, env: { PORT: port() } })
      .check({ name: "uses-env", run: ({ env }) => { seen = env.PORT; } })
      .start();
    assert.equal(seen, 8080);
  });
});

describe("check phase", () => {
  it("retries a required check, then fails the boot", async () => {
    let calls = 0;
    const boot = createBoot(quiet).check({
      name: "database",
      retry: { attempts: 3, delayMs: 5 },
      run: () => { calls++; throw new Error("ECONNREFUSED"); },
    });
    const err = await bootError(boot.start());
    assert.equal(calls, 3);
    assert.deepEqual(err.status.failedRequired, ["database"]);
    assert.match(err.report, /database.*required · 3 attempts.*ECONNREFUSED/);
  });

  it("becomes ready when a dependency comes up late", async () => {
    let calls = 0;
    const { status } = await createBoot(quiet)
      .check({
        name: "database",
        retry: { attempts: 5, delayMs: 5 },
        run: () => { if (++calls < 3) throw new Error("not yet"); },
      })
      .start();
    assert.equal(status.state, "ready");
    assert.equal(status.checks[0].attempts, 3);
  });

  it("an optional failure leaves the service ready but degraded", async () => {
    const boot = createBoot(quiet)
      .check({ name: "database", run: () => {} })
      .check({ name: "analytics", required: false, run: () => { throw new Error("down"); } });
    const { status } = await boot.start();
    assert.equal(status.state, "ready");
    assert.equal(status.degraded, true);
    assert.deepEqual(status.failedOptional, ["analytics"]);
    assert.equal(boot.probes.ready().status, 200);
  });

  it("times out a hanging attempt and aborts its signal", async () => {
    let aborted = false;
    const err = await bootError(
      createBoot(quiet)
        .check({
          name: "hangs",
          timeoutMs: 30,
          run: ({ signal }) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => { aborted = true; resolve(undefined); });
            }),
        })
        .start(),
    );
    assert.equal(aborted, true);
    assert.match(err.status.checks[0].error!, /timed out after 30ms/);
  });

  it("runs checks in parallel", async () => {
    const t0 = performance.now();
    const slow = (name: string) => ({ name, run: () => new Promise((r) => setTimeout(r, 60)) });
    await createBoot(quiet).check(slow("a")).check(slow("b")).check(slow("c")).start();
    assert.ok(performance.now() - t0 < 150, "three 60ms checks should finish in about 60ms");
  });

  it("doubles the delay when backoff is on, up to the cap", () => {
    const p = { attempts: 6, delayMs: 100, backoff: true, maxDelayMs: 500 };
    assert.deepEqual([1, 2, 3, 4].map((n) => delayFor(p, n)), [100, 200, 400, 500]);
    assert.equal(delayFor({ attempts: 3, delayMs: 100 }, 3), 100);
  });
});

describe("secret masking", () => {
  it("masks secret values that leak into check errors", async () => {
    const err = await bootError(
      createBoot({ ...quiet, source: { DB_PASSWORD: "hunter2-very-secret" }, env: { DB_PASSWORD: str() } })
        .check({ name: "db", run: ({ env }) => { throw new Error(`auth failed for ${env.DB_PASSWORD}`); } })
        .start(),
    );
    assert.ok(!err.report.includes("hunter2-very-secret"));
    assert.match(err.report, /auth failed for \*\*\*\*/);
  });

  it("masks secrets that a third-party validator echoes in its message", async () => {
    const echoes: StandardSchemaV1<unknown, string> = {
      "~standard": { version: 1, vendor: "test", validate: (v) => ({ issues: [{ message: `bad value "${v}"` }] }) },
    };
    const err = await bootError(
      createBoot({ ...quiet, source: { API_TOKEN: "tok_live_9876" }, env: { API_TOKEN: echoes } }).start(),
    );
    assert.ok(!err.report.includes("tok_live_9876"));
    assert.match(err.report, /bad value "\*\*\*\*"/);
  });

  it("masks passwords inside URLs and values marked secret", () => {
    const mask = createMasker(["tok_abc123"]);
    assert.equal(mask("postgres://app:pa55@db:5432/x"), "postgres://app:****@db:5432/x");
    assert.equal(mask("bad token tok_abc123"), "bad token ****");
  });
});

describe("lifecycle", () => {
  it("start() is idempotent and ready is a shared barrier", async () => {
    const boot = createBoot(quiet).check({ name: "a", run: () => {} });
    const waiting = boot.ready;
    const [r1, r2, r3] = await Promise.all([boot.start(), boot.start(), waiting]);
    assert.equal(r1, r2);
    assert.equal(r3.status.state, "ready");
  });

  it("locks registration once start() is called", async () => {
    const boot = createBoot(quiet);
    const p = boot.start();
    assert.throws(() => boot.check({ name: "late", run: () => {} }), /after start\(\)/);
    await p;
  });

  it("rejects duplicate check names", () => {
    const boot = createBoot(quiet).check({ name: "db", run: () => {} });
    assert.throws(() => boot.check({ name: "db", run: () => {} }), /already registered/);
  });
});

describe("probes", () => {
  it("liveness stays 200 even when boot failed; readiness does not", async () => {
    const boot = createBoot(quiet).check({ name: "db", run: () => { throw new Error("x"); } });
    assert.equal(boot.probes.ready().status, 503);
    await bootError(boot.start());
    assert.equal(boot.probes.live().status, 200);
    assert.equal(boot.probes.ready().status, 503);
    const body = await boot.probes.ready().json();
    assert.deepEqual(body.failedRequired, ["db"]);
    assert.equal(JSON.stringify(body).includes("x\""), false, "probe bodies carry names, not error text");
  });

  it("routes by path", async () => {
    const boot = createBoot(quiet);
    await boot.start();
    const get = (p: string) => boot.probes.fetch(new Request(`http://local${p}`)).status;
    assert.deepEqual([get("/health/live"), get("/ready/"), get("/startup"), get("/other")], [200, 200, 200, 404]);
  });
});

describe("runtime", () => {
  it("detects the current runtime", () => {
    const expected = typeof (globalThis as any).Deno === "object"
      ? "deno"
      : typeof (globalThis as any).Bun === "object"
        ? "bun"
        : "node";
    assert.equal(detectRuntime(), expected);
  });

  it("defaults to throw on runtimes without a process", async () => {
    const boot = createBoot({ runtime: "workerd", logger: false, source: {}, env: { X: str() } });
    await bootError(boot.start());
  });
});
