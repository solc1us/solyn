// CLI-only composition. Never import this module from application routes.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@solyn/db";
import * as schema from "@solyn/db/schema/auth";
import { betterAuth } from "better-auth";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { z } from "zod";

import type { AuthConfig } from "./index";

export class ProvisioningError extends Error {}

const stageLabels = {
  "input-validation": "Configuration and credential input",
  "database-connection": "Database connection",
  "transaction-initialization": "Transaction initialization",
  "auth-table-verification": "Auth table verification",
  "table-locking": "Table locking",
  "existing-user-check": "Existing-user check",
  "better-auth-signup": "Better Auth signup",
  "credential-verification": "Credential verification",
  "transaction-commit": "Transaction commit",
  "connection-cleanup": "Connection cleanup",
} as const;
export type ProvisioningStage = keyof typeof stageLabels;

const postgresCodes = {
  DATABASE_AUTHENTICATION: ["28P01", "28000"],
  DATABASE_NOT_FOUND: ["3D000"],
  DATABASE_PERMISSION: ["42501"],
  AUTH_SCHEMA_MISMATCH: ["42P01", "42703", "42704", "42883", "42601"],
  DATABASE_CONSTRAINT: ["23502", "23503", "23505", "23514"],
  TRANSACTION_CONTENTION: ["40001", "40P01", "55P03"],
  STATEMENT_CANCELLED: ["57014"],
  TRANSACTION_STATE: ["25P02", "25006"],
  DATABASE_CONNECTION: ["08000", "08001", "08003", "08004", "08006", "08007", "08P01"],
  DATABASE_UNAVAILABLE: ["53300", "53400", "57P01", "57P02", "57P03"],
  DATABASE_SERVER_ERROR: ["XX000"],
} as const;
const driverCodes = {
  TLS_CERTIFICATE_VERIFICATION: [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_GET_ISSUER_CERT",
    "CERTIFICATE_VERIFY_FAILED",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_UNTRUSTED",
  ],
  DNS_LOOKUP: ["ENOTFOUND", "EAI_AGAIN"],
  CONNECTION_TIMEOUT: ["ETIMEDOUT", "ERR_TLS_HANDSHAKE_TIMEOUT"],
  CONNECTION_REFUSED: ["ECONNREFUSED"],
  CONNECTION_INTERRUPTED: [
    "ECONNRESET",
    "EPIPE",
    "ERR_SOCKET_CLOSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ],
} as const;
type DiagnosticCategory =
  | keyof typeof postgresCodes
  | keyof typeof driverCodes
  | "PRECONDITION_FAILED"
  | "CANCELLED"
  | "AUTH_SIGNUP_REJECTED"
  | "UNCLASSIFIED";
type Diagnostic = { category: DiagnosticCategory; postgresCode?: string };

// Read only data properties; never stringify unknown exceptions or invoke their
// getters. Drizzle wraps driver failures in cause, which can contain secrets.
function ownValue(error: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(error, key)?.value;
}
function classifyFailure(error: unknown): Diagnostic {
  const seen = new Set<object>();
  for (
    let depth = 0;
    depth < 6 && error && typeof error === "object" && !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const code = ownValue(error, "code");
    for (const [category, codes] of Object.entries(postgresCodes))
      if (typeof code === "string" && (codes as readonly string[]).includes(code))
        return { category: category as keyof typeof postgresCodes, postgresCode: code };
    for (const [category, codes] of Object.entries(driverCodes))
      if (typeof code === "string" && (codes as readonly string[]).includes(code))
        return { category: category as keyof typeof driverCodes };
    if (error instanceof ProvisioningError) return { category: "PRECONDITION_FAILED" };
    if (code === "ABORT_ERR" || (error instanceof DOMException && error.name === "AbortError"))
      return { category: "CANCELLED" };
    // pg-pool emits these exact, code-less timeout errors. No arbitrary message
    // fragments, URLs, hostnames, certificate details or API bodies are echoed.
    if (
      [
        "timeout exceeded when trying to connect",
        "Connection terminated due to connection timeout",
      ].includes(ownValue(error, "message") as string)
    )
      return { category: "CONNECTION_TIMEOUT" };
    const body = ownValue(error, "body");
    if (
      body &&
      typeof body === "object" &&
      [
        "FAILED_TO_CREATE_USER",
        "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        "EMAIL_PASSWORD_SIGN_UP_DISABLED",
        "INVALID_EMAIL",
        "INVALID_PASSWORD",
        "PASSWORD_TOO_SHORT",
        "PASSWORD_TOO_LONG",
      ].includes(ownValue(body, "code") as string)
    )
      return { category: "AUTH_SIGNUP_REJECTED" };
    error = ownValue(error, "cause");
  }
  return { category: "UNCLASSIFIED" };
}

// Deliberately retain NO original error/cause, query, params or message.
export class ProvisioningFailure extends Error {
  readonly diagnostic: Diagnostic;
  constructor(
    readonly stage: ProvisioningStage,
    error: unknown,
  ) {
    super("Provisioning failed.");
    this.diagnostic = classifyFailure(error);
  }
}
export function describeProvisioningFailure(error: unknown, fallback: ProvisioningStage) {
  const failure =
    error instanceof ProvisioningFailure ? error : new ProvisioningFailure(fallback, error);
  const { category, postgresCode } = failure.diagnostic;
  const preconditions: Partial<Record<ProvisioningStage, string>> = {
    "input-validation":
      "Check development configuration, target approval, terminal and credential input.",
    "auth-table-verification":
      "Required Better Auth tables must exist; migration is a separate approval.",
    "existing-user-check":
      "Any existing user prevents provisioning; no account is adopted or changed.",
    "credential-verification":
      "Expected exactly one matching user and credential account, and no session.",
  };
  const hint = category === "PRECONDITION_FAILED" ? preconditions[failure.stage] : undefined;
  return `Failed stage: ${stageLabels[failure.stage]}. Category: ${category}.${postgresCode ? ` PostgreSQL code: ${postgresCode}.` : ""}${hint ? ` ${hint}` : ""}`;
}

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
  let stage: ProvisioningStage = "database-connection";
  let enteredTransaction = false;
  try {
    await database.transaction(
      async (tx) => {
        enteredTransaction = true;
        stage = "transaction-initialization";
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        await tx.execute(sql`set local search_path = pg_catalog, public`);
        // Fail rather than mistaking an RLS-filtered user table for an empty one.
        await tx.execute(sql`set local row_security = off`);
        stage = "auth-table-verification";
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
        stage = "table-locking";
        await tx.execute(
          sql`lock table public."user", public.account, public.session, public.verification in exclusive mode`,
        );
        stage = "existing-user-check";
        const existing = await tx.select({ id: schema.user.id }).from(schema.user).limit(1);
        if (existing.length)
          throw new ProvisioningError(
            "Provisioning refused: a user already exists. No account was adopted or changed.",
          );
        signal?.throwIfAborted();
        // In 1.7.12, transaction:false makes the adapter's transaction wrapper
        // execute on this captured tx, NOT on the pool. The OUTER Drizzle transaction
        // owns the lock, all signup queries, verification, COMMIT and ROLLBACK.
        stage = "better-auth-signup";
        const auth = betterAuth({
          database: drizzleAdapter(tx, { provider: "pg", schema, transaction: false }),
          secret: config.BETTER_AUTH_SECRET,
          baseURL: config.BETTER_AUTH_URL,
          trustedOrigins: [config.BETTER_AUTH_URL],
          emailAndPassword: { enabled: true, disableSignUp: false, autoSignIn: false },
          logger: { disabled: true },
        });
        const result = await auth.api.signUpEmail({ body: parsed.data });
        stage = "credential-verification";
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
        stage = "transaction-commit";
      },
      { isolationLevel: "read committed" },
    );
  } catch (error) {
    // Installed Drizzle checks out the client before executing BEGIN. A wrapped
    // query failure before our callback is BEGIN, not a network/TLS checkout.
    if (!enteredTransaction && error instanceof DrizzleQueryError)
      stage = "transaction-initialization";
    throw new ProvisioningFailure(stage, error);
  } finally {
    parsed.data.password = "";
  }
}
