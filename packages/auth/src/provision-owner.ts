// CLI-only composition. Never import this module from application routes.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@solyn/db";
import * as schema from "@solyn/db/schema/auth";
import { betterAuth } from "better-auth";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { AuthConfig } from "./index";

export class ProvisioningError extends Error {}

export function validateDevelopmentTarget(env: Record<string, string | undefined>) {
  if (env.NODE_ENV !== "development")
    throw new ProvisioningError("Owner provisioning requires NODE_ENV=development.");
  if (!env.DATABASE_URL || !env.SOLYN_OWNER_DEV_TARGET)
    throw new ProvisioningError(
      "Set DATABASE_URL and the independently PM-approved SOLYN_OWNER_DEV_TARGET.",
    );
  try {
    const actual = new URL(env.DATABASE_URL);
    const approved = new URL(env.SOLYN_OWNER_DEV_TARGET);
    const identity = (url: URL) => {
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.hostname ||
        !url.username ||
        !url.pathname.slice(1) ||
        url.hash
      )
        throw new Error();
      if (
        /[/\\]/.test(decodeURIComponent(url.hostname)) ||
        /[/\\]/.test(decodeURIComponent(url.pathname.slice(1)))
      )
        throw new Error();
      return JSON.stringify([
        url.hostname.toLowerCase(),
        url.port || "5432",
        decodeURIComponent(url.username),
        decodeURIComponent(url.pathname.slice(1)),
      ]);
    };
    if (approved.password || approved.search || identity(actual) !== identity(approved))
      throw new Error();
    // pg also accepts routing/connection options in URL query parameters. Do not
    // allow those to redirect an otherwise approved host/user/database identity.
    if (
      [...actual.searchParams.keys()].some((key) => key !== "sslmode") ||
      actual.searchParams.getAll("sslmode").length > 1
    )
      throw new Error();
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(actual.hostname.toLowerCase());
    const sslMode = actual.searchParams.get("sslmode");
    if (
      local
        ? sslMode !== null && !["disable", "verify-full"].includes(sslMode)
        : sslMode !== "verify-full"
    )
      throw new Error();
  } catch {
    throw new ProvisioningError(
      "Development target rejected. Check the approved host, port, database and user; use sslmode=verify-full for remote connections. Target approval must contain no password or query options.",
    );
  }
  if (!env.BETTER_AUTH_URL || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new ProvisioningError("Valid BETTER_AUTH_URL and BETTER_AUTH_SECRET are required.");
  try {
    new URL(env.BETTER_AUTH_URL);
  } catch {
    throw new ProvisioningError("BETTER_AUTH_URL is invalid.");
  }
  return {
    DATABASE_URL: env.DATABASE_URL,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  };
}

export const ownerInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().trim().toLowerCase().max(320),
    password: z
      .string()
      .min(8)
      .max(128)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

// Trusted CLI/test seam only: the caller constructs the database exclusively from
// validateDevelopmentTarget's result. The application keeps createAuth unchanged.
export async function provisionOwner(
  database: Database,
  config: AuthConfig,
  input: unknown,
  signal?: AbortSignal,
) {
  const parsed = ownerInput.safeParse(input);
  if (!parsed.success)
    throw new ProvisioningError(
      "Invalid owner input. Use a name, valid email and an 8–128 character nonblank password.",
    );
  signal?.throwIfAborted();
  try {
    await database.transaction(
      async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        await tx.execute(sql`set local search_path = pg_catalog, public`);
        // Fail rather than mistaking an RLS-filtered user table for an empty one.
        await tx.execute(sql`set local row_security = off`);
        const tables = await tx.execute<{ ready: boolean }>(sql`
        select count(*) = 4 as ready from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('user', 'account', 'session', 'verification')
        and c.relkind in ('r', 'p')
      `);
        if (tables.rows[0]?.ready !== true)
          throw new ProvisioningError(
            "Required Better Auth tables are missing. Complete the approved migration separately.",
          );
        await tx.execute(
          sql`lock table public."user", public.account, public.session, public.verification in exclusive mode`,
        );
        const existing = await tx.select({ id: schema.user.id }).from(schema.user).limit(1);
        if (existing.length)
          throw new ProvisioningError(
            "Provisioning refused: a user already exists. No account was adopted or changed.",
          );
        signal?.throwIfAborted();
        // In 1.7.12, transaction:false makes the adapter's transaction wrapper
        // execute on this captured tx, NOT on the pool. The OUTER Drizzle transaction
        // owns the lock, all signup queries, verification, COMMIT and ROLLBACK.
        const auth = betterAuth({
          database: drizzleAdapter(tx, { provider: "pg", schema, transaction: false }),
          secret: config.BETTER_AUTH_SECRET,
          baseURL: config.BETTER_AUTH_URL,
          trustedOrigins: [config.BETTER_AUTH_URL],
          emailAndPassword: { enabled: true, disableSignUp: false, autoSignIn: false },
          logger: { disabled: true },
        });
        const result = await auth.api.signUpEmail({ body: parsed.data });
        const verification = await tx.execute<{ valid: boolean }>(sql`
        select
          (select count(*) from public."user") = 1
          and (select count(*) from public.account) = 1
          and (select count(*) from public.session) = 0
          and exists (select 1 from public."user" u join public.account a on a.user_id = u.id
            where u.id = ${result.user.id} and u.email = ${parsed.data.email} and u.name = ${parsed.data.name}
            and a.provider_id = 'credential' and a.account_id = u.id and a.password is not null and a.password <> '')
          as valid
      `);
        if (result.token !== null || verification.rows[0]?.valid !== true)
          throw new ProvisioningError(
            "Owner and credential verification failed; provisioning was not confirmed.",
          );
        signal?.throwIfAborted();
      },
      { isolationLevel: "read committed" },
    );
  } finally {
    parsed.data.password = "";
  }
}
