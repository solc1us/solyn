import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

import { createDb } from "@solyn/db";
import { verifyPassword } from "better-auth/crypto";

import {
  describeProvisioningFailure,
  ownerInput,
  provisionOwner,
  ProvisioningFailure,
  validateDevelopmentTarget,
} from "./provision-owner";

const config = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "offline-only-secret-at-least-thirty-two-characters",
};
const owner = {
  name: "Initial owner",
  email: "owner@example.test",
  password: "offline-test-password",
};
const env = {
  ...config,
  NODE_ENV: "development",
  DATABASE_URL:
    "postgresql://postgres.dev:unused@db.example.test:5432/postgres?sslmode=verify-full",
  SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.dev@db.example.test:5432/postgres",
};

// Real Better Auth API + real Drizzle builders/transaction session, scripted
// non-network pg driver. Pool queries fail: every operation must use the one
// checked-out client. This proves transaction routing, NOT PostgreSQL atomicity.
function fixture(
  options: {
    existing?: boolean;
    missing?: boolean;
    invalid?: boolean;
    fail?: RegExp;
    error?: unknown;
    connectError?: unknown;
    afterUser?: () => void;
  } = {},
) {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const calls: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  let connections = 0,
    releases = 0,
    poolQueries = 0;
  db.$client.query = (() => {
    poolQueries++;
    throw new Error("Query escaped the transaction client");
  }) as typeof db.$client.query;
  const query = async (request: { text: string; rowMode?: string }, params: unknown[] = []) => {
    const text = request.text;
    calls.push(text);
    if (options.fail?.test(text))
      throw options.error ?? new Error("Injected driver failure; never log this object");
    let rows: unknown[] = [];
    if (text.includes("pg_catalog.pg_class")) rows = [{ ready: !options.missing }];
    else if (text.startsWith('select "id" from "user"'))
      rows = options.existing ? [["another-user"]] : [];
    else if (text.startsWith("insert into")) {
      const match = text.match(
        /^insert into "(user|account)" \((.*?)\) values \((.*?)\) returning (.*)$/,
      );
      assert.ok(match, "Unexpected insert shape");
      const columns = match[2]!.split(",").map((value) => value.trim().replaceAll('"', ""));
      const values = match[3]!.split(",").map((value) => value.trim());
      const data: Record<string, unknown> = {};
      columns.forEach((column, i) => {
        const parameter = values[i]!.match(/^\$(\d+)$/);
        data[column] = parameter
          ? params[Number(parameter[1]) - 1]
          : column.endsWith("_at")
            ? new Date("2026-01-01")
            : null;
      });
      inserted.push({ table: match[1], ...data });
      if (match[1] === "user") options.afterUser?.();
      rows = [match[4]!.split(",").map((column) => data[column.trim().replaceAll('"', "")])];
    } else if (text.includes("as valid")) rows = [{ valid: !options.invalid }];
    return { rows, rowCount: rows.length };
  };
  const client = {
    query,
    on() {},
    off() {},
    release() {
      releases++;
    },
  };
  db.$client.connect = (async () => {
    connections++;
    if (options.connectError) throw options.connectError;
    return client;
  }) as unknown as typeof db.$client.connect;
  return { db, calls, inserted, stats: () => ({ connections, releases, poolQueries }) };
}

test("the supported signup API and credential hashing stay on the locked outer transaction client", async () => {
  const f = fixture();
  await provisionOwner(f.db, config, owner);
  assert.deepEqual(f.stats(), { connections: 1, releases: 1, poolQueries: 0 });
  assert.match(f.calls[0]!, /^begin isolation level read committed/);
  const lock = f.calls.findIndex((text) => text.startsWith("lock table"));
  const empty = f.calls.findIndex((text) => text.startsWith('select "id" from "user"'));
  const userInsert = f.calls.findIndex((text) => text.startsWith('insert into "user"'));
  const accountInsert = f.calls.findIndex((text) => text.startsWith('insert into "account"'));
  const verification = f.calls.findIndex((text) => text.includes("as valid"));
  assert.ok(
    lock >= 0 &&
      lock < empty &&
      empty < userInsert &&
      userInsert < accountInsert &&
      accountInsert < verification,
  );
  assert.match(
    f.calls[lock]!,
    /public\."user".*public\.account.*public\.session.*public\.verification in exclusive mode/,
  );
  assert.ok(f.calls.some((text) => text === "set local row_security = off"));
  assert.equal(f.calls.at(-1), "commit");
  assert.ok(!f.calls.some((text) => /savepoint|insert into "session"/.test(text)));
  assert.equal(f.inserted.length, 2);
  const account = f.inserted.find((row) => row.table === "account")!;
  assert.equal(account.provider_id, "credential");
  assert.equal(account.user_id, f.inserted[0]!.id);
  assert.equal(account.account_id, account.user_id);
  assert.ok(typeof account.password === "string" && account.password !== owner.password);
  assert.ok(await verifyPassword({ hash: account.password as string, password: owner.password }));
  assert.equal(owner.password, "offline-test-password");
});

test("any pre-existing user prevents signup regardless of email", async () => {
  const f = fixture({ existing: true });
  await assert.rejects(
    provisionOwner(f.db, config, owner),
    (error) =>
      error instanceof ProvisioningFailure &&
      error.stage === "existing-user-check" &&
      error.diagnostic.category === "PRECONDITION_FAILED",
  );
  assert.equal(f.inserted.length, 0);
  assert.equal(f.calls.at(-1), "rollback");
  assert.equal(f.stats().releases, 1);
});

test("missing auth tables abort before lock or signup", async () => {
  const f = fixture({ missing: true });
  await assert.rejects(
    provisionOwner(f.db, config, owner),
    (error) =>
      error instanceof ProvisioningFailure &&
      error.stage === "auth-table-verification" &&
      error.diagnostic.category === "PRECONDITION_FAILED",
  );
  assert.ok(!f.calls.some((text) => text.startsWith("lock table")));
  assert.equal(f.inserted.length, 0);
  assert.equal(f.calls.at(-1), "rollback");
});

for (const [name, options] of [
  ["credential failure", { fail: /^insert into "account"/ }],
  ["post-create verification failure", { invalid: true }],
  ["lock timeout", { fail: /^lock table/ }],
  ["commit failure", { fail: /^commit$/ }],
] as const)
  test(`${name} requests rollback on the same client and releases it`, async () => {
    const f = fixture(options);
    await assert.rejects(provisionOwner(f.db, config, owner));
    assert.equal(f.calls.at(-1), "rollback");
    assert.deepEqual(f.stats(), { connections: 1, releases: 1, poolQueries: 0 });
  });

test("cancelled or invalid inputs never start a transaction", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provisionOwner(f.db, config, owner, controller.signal));
  await assert.rejects(provisionOwner(f.db, config, { ...owner, password: "short" }));
  assert.equal(f.calls.length, 0);
  assert.equal(ownerInput.safeParse({ ...owner, password: "        " }).success, false);
});

test("an abort after the user insert cannot commit a partial signup", async () => {
  const controller = new AbortController();
  const f = fixture({ afterUser: () => controller.abort() });
  await assert.rejects(provisionOwner(f.db, config, owner, controller.signal));
  assert.equal(f.calls.at(-1), "rollback");
});

for (const [stage, fail, code] of [
  ["transaction-initialization", /^begin/, "42501"],
  ["transaction-initialization", /^set local/, "42501"],
  ["auth-table-verification", /pg_catalog.pg_class/, "42P01"],
  ["table-locking", /^lock table/, "55P03"],
  ["existing-user-check", /^select "id" from "user"/, "42501"],
  ["better-auth-signup", /^insert into "account"/, "23505"],
  ["credential-verification", /as valid/, "42501"],
  ["transaction-commit", /^commit$/, "08007"],
] as const)
  test(`diagnostics identify ${stage} and allowlisted PostgreSQL code`, async () => {
    const f = fixture({
      fail,
      error: Object.assign(new Error("private driver details"), { code }),
    });
    await assert.rejects(provisionOwner(f.db, config, owner), (error) => {
      assert.ok(error instanceof ProvisioningFailure);
      assert.equal(error.stage, stage);
      assert.equal(error.diagnostic.postgresCode, code);
      const diagnostic = describeProvisioningFailure(error, "input-validation");
      assert.ok(diagnostic.includes(code));
      assert.ok(!diagnostic.includes("private driver details"));
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.ok(!JSON.stringify(error).includes(owner.password));
      return true;
    });
  });

test("checkout/TLS failures are distinguished from BEGIN without opening a connection", async () => {
  const f = fixture({
    connectError: Object.assign(new Error("private hostname and certificate"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }),
  });
  await assert.rejects(provisionOwner(f.db, config, owner), (error) => {
    assert.ok(error instanceof ProvisioningFailure);
    assert.equal(error.stage, "database-connection");
    assert.equal(error.diagnostic.category, "TLS_CERTIFICATE_VERIFICATION");
    assert.equal(error.diagnostic.postgresCode, undefined);
    assert.ok(!describeProvisioningFailure(error, "input-validation").includes("private hostname"));
    return true;
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.stats().releases, 0);
});

test("Better Auth's normalized creation failure is reported without its API body", async () => {
  const f = fixture({
    fail: /^insert into "user"/,
    error: Object.assign(new Error("private creation details"), { code: "42501" }),
  });
  await assert.rejects(provisionOwner(f.db, config, owner), (error) => {
    assert.ok(error instanceof ProvisioningFailure);
    assert.equal(error.stage, "better-auth-signup");
    assert.equal(error.diagnostic.category, "AUTH_SIGNUP_REJECTED");
    // Better Auth intentionally discards this original driver error; do not invent a code.
    assert.equal(error.diagnostic.postgresCode, undefined);
    return true;
  });
});

test("diagnostics never expose unknown messages, codes, stacks, query parameters or API fields", () => {
  const secret = "private-password-hash-token-connection-string";
  for (const error of [
    secret,
    null,
    Object.assign(new Error(secret), {
      code: secret,
      params: [secret],
      detail: secret,
      stack: secret,
      body: { message: secret, token: secret },
    }),
    { code: "00000", message: "timeout exceeded when trying to connect " + secret },
    {
      get message() {
        throw new Error("Getter must not run");
      },
      get cause() {
        throw new Error("Getter must not run");
      },
    },
  ]) {
    const text = describeProvisioningFailure(error, "connection-cleanup");
    assert.equal(text, "Failed stage: Connection cleanup. Category: UNCLASSIFIED.");
    assert.ok(!text.includes(secret));
  }
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.match(describeProvisioningFailure(cycle, "connection-cleanup"), /UNCLASSIFIED/);
});

test("known nested codes, cancellation, exact code-less timeouts and cleanup use safe categories", () => {
  for (const [error, category] of [
    [{ cause: { cause: { code: "28P01", message: "private" } } }, "DATABASE_AUTHENTICATION"],
    [{ code: "ENOTFOUND", hostname: "private" }, "DNS_LOOKUP"],
    [{ code: "ECONNREFUSED" }, "CONNECTION_REFUSED"],
    [{ code: "ECONNRESET" }, "CONNECTION_INTERRUPTED"],
    [new Error("timeout exceeded when trying to connect"), "CONNECTION_TIMEOUT"],
    [{ code: "ABORT_ERR" }, "CANCELLED"],
    [new DOMException("private", "AbortError"), "CANCELLED"],
  ] as const) {
    const text = describeProvisioningFailure(error, "connection-cleanup");
    assert.ok(text.includes(`Category: ${category}.`));
    assert.ok(!text.includes("private"));
  }
});

test("the installed pg parser preserves Session Pooler identity and certificate verification offline", () => {
  // Constructor/parsing only. Never call connect(), query() or the provisioning CLI.
  const requireDb = createRequire(import.meta.resolve("@solyn/db"));
  const { Client } = requireDb("pg") as {
    Client: new (config: { connectionString: string }) => {
      connectionParameters: {
        host: string;
        port: number;
        user: string;
        database: string;
        ssl: boolean | { rejectUnauthorized?: boolean };
      };
    };
  };
  const host = "aws-0-example.pooler.supabase.com";
  const user = "postgres.abcdefghijklmnopqrst";
  const target = `postgresql://${user}@${host}:5432/postgres`;
  const validated = validateDevelopmentTarget({
    ...env,
    SOLYN_OWNER_DEV_TARGET: target,
    DATABASE_URL: `postgresql://${user}:unused@${host}:5432/postgres?sslmode=verify-full`,
  });
  const parameters = new Client({ connectionString: validated.DATABASE_URL }).connectionParameters;
  assert.equal(parameters.host, host);
  assert.equal(parameters.port, 5432);
  assert.equal(parameters.user, user);
  assert.equal(parameters.database, "postgres");
  assert.ok(
    parameters.ssl === true ||
      (typeof parameters.ssl === "object" && parameters.ssl.rejectUnauthorized !== false),
  );
});

test("target guard needs development AND an independently configured exact identity", () => {
  assert.equal(validateDevelopmentTarget(env).DATABASE_URL, env.DATABASE_URL);
  for (const overrides of [
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { SOLYN_OWNER_DEV_TARGET: undefined },
    { SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.prod@db.example.test:5432/postgres" },
    { SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.dev@other.example.test:5432/postgres" },
    { SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.dev@db.example.test:5433/postgres" },
    { SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.dev@db.example.test:5432/other" },
    { SOLYN_OWNER_DEV_TARGET: "postgresql://postgres.dev:secret@db.example.test/postgres" },
    { DATABASE_URL: "postgresql://postgres.dev:unused@db.example.test/postgres" },
    { DATABASE_URL: env.DATABASE_URL + "&host=other.example.test" },
    { DATABASE_URL: env.DATABASE_URL + "&options=-csearch_path=other" },
    { DATABASE_URL: env.DATABASE_URL + "&sslmode=disable" },
  ])
    assert.throws(
      () => validateDevelopmentTarget({ ...env, ...overrides }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("unused") && !error.message.includes("postgresql://"));
        return true;
      },
    );
});
