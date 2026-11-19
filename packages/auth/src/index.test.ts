import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { inspect } from "node:util";

import { createDb } from "@solyn/db";

import { createAuth } from "./index";

// No real credentials: fail before any attempted query or connection.
const database = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
let databaseCalls = 0;
const denyDatabase = () => {
  databaseCalls++;
  throw new Error("Database access is forbidden in auth foundation tests");
};
database.$client.query = denyDatabase;
database.$client.connect = denyDatabase;

const origin = "http://localhost:3001";
const syntheticSecret = "test-only-secret-at-least-thirty-two-characters";
const auth = createAuth(
  {
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: syntheticSecret,
  },
  database,
);

test("public email/password registration is rejected without database access", async () => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        name: "Not an owner",
        email: "blocked@example.com",
        password: "test-password-only",
      }),
    }),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
  assert.equal(databaseCalls, 0);
});

// Capture only synthetic test output, never intercept production logging.
async function captureLogs(work: () => Promise<void>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const originals = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    debug: console.debug,
  };
  for (const method of ["error", "warn", "log", "debug"] as const)
    console[method] = (...args: unknown[]) => {
      calls.push({ method, args });
    };
  try {
    await work();
    return calls;
  } finally {
    Object.assign(console, originals);
  }
}
function offlineAuth(error?: Error) {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  let queries = 0;
  db.$client.query = (async () => {
    queries++;
    throw error ?? new Error("Unexpected synthetic database access");
  }) as typeof db.$client.query;
  db.$client.connect = async () => {
    throw new Error("Offline auth test must not connect");
  };
  return {
    auth: createAuth({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: syntheticSecret }, db),
    queries: () => queries,
  };
}
async function signedSessionHeaders(instance: ReturnType<typeof createAuth>, token: string) {
  const context = await instance.$context;
  const signature = createHmac("sha256", syntheticSecret).update(token).digest("base64");
  return new Headers({ cookie: `${context.authCookies.sessionToken.name}=${token}.${signature}` });
}

test("session database exceptions and nested causes cannot leak through Better Auth logging", async () => {
  const sentinels = ["SQL_SENTINEL", "CREDENTIAL_SENTINEL", "NESTED_SENTINEL", "COOKIE_SENTINEL"];
  for (const nested of [false, true]) {
    const privateError = new Error("SELECT SQL_SENTINEL WHERE password = CREDENTIAL_SENTINEL", {
      cause: nested
        ? new Error("NESTED_SENTINEL", { cause: { params: ["COOKIE_SENTINEL"] } })
        : undefined,
    });
    const f = offlineAuth(privateError);
    const headers = await signedSessionHeaders(f.auth, "COOKIE_SENTINEL");
    const logs = await captureLogs(async () => {
      await assert.rejects(f.auth.api.getSession({ headers }), (error: unknown) => {
        const failure = error as { status?: string; body?: { code?: string } };
        return (
          failure.status === "INTERNAL_SERVER_ERROR" &&
          failure.body?.code === "FAILED_TO_GET_SESSION"
        );
      });
    });
    assert.equal(f.queries(), 1);
    assert.ok(logs.length > 0, "Operational error diagnostics must remain available");
    const output = inspect(logs, { depth: 20 });
    for (const sentinel of sentinels)
      assert.equal(
        output.includes(sentinel),
        false,
        "Sensitive synthetic content must not be logged",
      );
    assert.deepEqual(logs, [
      { method: "error", args: ["[Better Auth] ERROR INTERNAL_SERVER_ERROR"] },
    ]);
  }
});

test("custom logger drops sensitive messages and extra arguments while retaining fixed severity diagnostics", async () => {
  const f = offlineAuth();
  const log: (
    level: "error" | "warn" | "info" | "debug",
    message: string,
    ...args: unknown[]
  ) => void = f.auth.options.logger!.log!;
  const sensitive = {
    sql: "SQL_SENTINEL",
    credentials: "CREDENTIAL_SENTINEL",
    cookie: "COOKIE_SENTINEL",
    sessionToken: "TOKEN_SENTINEL",
    body: "BODY_SENTINEL",
    error: new Error("EXCEPTION_SENTINEL", { cause: new Error("CAUSE_SENTINEL") }),
    get stack() {
      throw new Error("Extra arguments must not be inspected");
    },
  };
  const logs = await captureLogs(async () => {
    for (const level of ["error", "warn", "info", "debug"] as const)
      log(level, "INTERNAL_SERVER_ERROR MESSAGE_SENTINEL", sensitive, "ARG_SENTINEL");
    log("error", "INTERNAL_SERVER_ERROR", sensitive);
  });
  assert.equal(inspect(logs).includes("SENTINEL"), false);
  assert.deepEqual(logs, [
    { method: "error", args: ["[Better Auth] ERROR AUTH_EVENT"] },
    { method: "warn", args: ["[Better Auth] WARN AUTH_EVENT"] },
    { method: "log", args: ["[Better Auth] INFO AUTH_EVENT"] },
    { method: "debug", args: ["[Better Auth] DEBUG AUTH_EVENT"] },
    { method: "error", args: ["[Better Auth] ERROR INTERNAL_SERVER_ERROR"] },
  ]);
});

test("installed Better Auth logger preserves the default warn threshold and safe operational output", async () => {
  const context = await offlineAuth().auth.$context;
  assert.equal(context.logger.level, "warn");
  const logs = await captureLogs(async () => {
    context.logger.debug("Debug details");
    context.logger.info("Informational details");
    context.logger.success("Successful operation");
    context.logger.warn("Operational warning");
    context.logger.error("INTERNAL_SERVER_ERROR", new Error("SENTINEL"));
  });
  assert.deepEqual(logs, [
    { method: "warn", args: ["[Better Auth] WARN AUTH_EVENT"] },
    { method: "error", args: ["[Better Auth] ERROR INTERNAL_SERVER_ERROR"] },
  ]);
});

test("session HTTP failure remains a safe 500 while its database details are omitted from logs", async () => {
  const f = offlineAuth(new Error("SQL_SENTINEL CREDENTIAL_SENTINEL"));
  const headers = await signedSessionHeaders(f.auth, "TOKEN_SENTINEL");
  const logs = await captureLogs(async () => {
    const response = await f.auth.handler(
      new Request(`${origin}/api/auth/get-session`, { headers }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      message: "Failed to get session",
      code: "FAILED_TO_GET_SESSION",
    });
  });
  assert.equal(f.queries(), 1);
  assert.equal(inspect(logs, { depth: 20 }).includes("SENTINEL"), false);
  assert.deepEqual(logs, [
    { method: "error", args: ["[Better Auth] ERROR INTERNAL_SERVER_ERROR"] },
  ]);
});

test("valid signed-session lookup preserves authentication and does not emit error logs", async () => {
  const f = offlineAuth();
  const context = await f.auth.$context;
  const now = new Date();
  const user = {
    id: "synthetic-user",
    name: "Synthetic User",
    email: "synthetic@example.com",
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const session = {
    id: "synthetic-session",
    token: "TOKEN_SENTINEL",
    userId: user.id,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
  };
  let lookups = 0;
  context.internalAdapter.findSession = async (token) => {
    lookups++;
    assert.equal(token, session.token);
    return { session, user };
  };
  const headers = await signedSessionHeaders(f.auth, session.token);
  const logs = await captureLogs(async () => {
    const result = await f.auth.api.getSession({ headers });
    assert.equal(result?.user.id, user.id);
    assert.equal(result?.session.id, session.id);
    assert.equal(result?.session.token, session.token);
    assert.equal(result?.session.expiresAt.getTime(), session.expiresAt.getTime());
  });
  assert.equal(lookups, 1);
  assert.equal(f.queries(), 0);
  assert.deepEqual(logs, []);
  assert.equal("session" in f.auth.options, false);
  assert.deepEqual(f.auth.options.emailAndPassword, { enabled: true, disableSignUp: true });
});

test("auth API remains available and anonymous requests have no session", async () => {
  const health = await auth.handler(new Request(`${origin}/api/auth/ok`));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
  assert.equal(auth.options.emailAndPassword?.enabled, true);
  assert.equal(typeof auth.api.signInEmail, "function");
  assert.equal(typeof auth.api.signOut, "function");
  assert.equal(databaseCalls, 0);
});
