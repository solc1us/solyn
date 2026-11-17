import assert from "node:assert/strict";
import { test } from "node:test";

import { createDb } from "@solyn/db";
import { verifyPassword } from "better-auth/crypto";

import { ownerInput, provisionOwner, validateDevelopmentTarget } from "./provision-owner";

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
    if (options.fail?.test(text)) throw new Error("Injected driver failure; never log this object");
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
  await assert.rejects(provisionOwner(f.db, config, owner), /a user already exists/);
  assert.equal(f.inserted.length, 0);
  assert.equal(f.calls.at(-1), "rollback");
  assert.equal(f.stats().releases, 1);
});

test("missing auth tables abort before lock or signup", async () => {
  const f = fixture({ missing: true });
  await assert.rejects(provisionOwner(f.db, config, owner), /tables are missing/);
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
