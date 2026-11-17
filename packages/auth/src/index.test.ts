import assert from "node:assert/strict";
import { test } from "node:test";

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
const auth = createAuth(
  {
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
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
