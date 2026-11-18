# One-time development owner provisioning

## Application behavior is unchanged

The application uses Better Auth 1.7.12 and its Drizzle PostgreSQL adapter. Public email/password signup remains disabled in `packages/auth/src/index.ts`, including direct API requests. Login/logout remain available. There is no signup page, provisioning HTTP route, admin plugin, or production provisioning mode.

The local CLI uses a separate, short-lived Better Auth instance. It never exports or mounts that instance's handler. Only this instance has `disableSignUp: false`, with `autoSignIn: false`, no Next.js cookie plugin, no email delivery hooks, and disabled auth logging.

**Implementation and offline tests do not constitute approval to execute it. No account was created during implementation.**

## Before running — PM approval required

1. Approve the exact separate development database and owner identity. Complete and review the database migration/baseline separately; this CLI never creates tables or runs migrations. In particular, do not blindly apply the initial migration to an existing auth database. Review Supabase Data API exposure/grants separately before trusting that target with account data.
2. Stop application writers and other maintenance operations. Concurrent copies of this CLI are serialized by database table locks, but this is not a substitute for stopping unrelated writers.
3. In a trusted local terminal, configure the existing git-ignored `apps/web/.env.local` (or another existing Varlock-supported local override/secret source). Do not put credentials in shell arguments, source, command history, or committed files.
4. Set `NODE_ENV=development`, the existing `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET`, and the CLI-only `SOLYN_OWNER_DEV_TARGET` described below. Never derive approval automatically from the current `DATABASE_URL`.

### Independent development-target guard

`SOLYN_OWNER_DEV_TARGET` is a **password-free connection identity independently approved by PM**, containing the exact host, port, username and database. It is optional for normal application use but mandatory for this CLI.

Placeholder example, not an approved target:

```dotenv
SOLYN_OWNER_DEV_TARGET=postgresql://APPROVED_USER@APPROVED_HOST:5432/APPROVED_DATABASE
```

For a shared Supabase pooler, the username must include the approved development project reference, exactly as supplied in its connection details; comparing the shared hostname alone is insufficient. For a direct connection, use its exact project-specific hostname and username. Do not include a password or query parameters in the approval identity.

The CLI compares **all four** identity components to `DATABASE_URL` before opening any connection. Only PostgreSQL URLs with explicit host/user/database are accepted; port defaults to 5432. Routing overrides such as `?host=...`, socket paths and arbitrary connection options are rejected. Non-loopback connections require `?sslmode=verify-full` in `DATABASE_URL`; use a trusted certificate chain rather than disabling verification. Loopback connections may omit SSL mode or use `disable`/`verify-full`.

This is a fail-closed operator-configured allowlist, not automatic proof that a server is non-production. PM must supply the development identity independently; deliberately approving a production identity defeats that safeguard. `NODE_ENV` alone never authorizes a target.

## Exact command

From the repository root:

```sh
bun run --filter web owner:provision
```

Alternatively, from `apps/web`:

```sh
bun run owner:provision
```

The package script runs `varlock run -- bun scripts/provision-owner.ts` in the web workspace. Varlock loads and validates the existing `.env.schema` and local/environment-specific overrides, and injects the environment into the CLI using the repository's existing conventions. Do not run the script with a password argument or pipe credentials into it.

The CLI requires an interactive input/output terminal. It asks for explicit approval/writer-stop confirmation, owner name, email, password, and password confirmation. Both password prompts suppress all terminal echo, have no readline history, and restore terminal mode on success, cancellation, or EOF. Passwords must be nonblank and 8–128 characters, matching Better Auth's length limits. Email is trimmed/lowercased; the name must be nonblank. Passwords are never trimmed.

A password mismatch or invalid input aborts before creating a database connection. Ctrl-C cancels input. All application and driver errors are reported without dumping error objects, SQL parameters, hashes, connection strings, tokens, or returned users. Password references are cleared on exit where practical; JavaScript strings cannot be reliably zeroized.

## Transaction, locking and duplicate prevention

`packages/auth/src/provision-owner.ts` implements the trusted CLI-only transaction path:

1. Begin a Drizzle **READ COMMITTED** transaction on one checked-out PostgreSQL client. Configure bounded lock/statement timeouts, a fixed `pg_catalog, public` search path, and `row_security = off` so restrictive RLS cannot silently make an existing user invisible. Insufficient permissions cause failure, not bypass or schema changes.
2. Verify all four public Better Auth tables (`user`, `account`, `session`, `verification`) exist as tables. Missing schema aborts; no repair is attempted.
3. Acquire `EXCLUSIVE` table locks in a fixed order on all four tables **before** checking for users. Abort if **any** user exists, regardless of email. There is no deletion, overwrite, adoption, or retry path.
4. Construct the private Better Auth instance with `drizzleAdapter(tx, { provider: "pg", schema, transaction: false })`. Invoke supported `auth.api.signUpEmail({ body: { name, email, password } })` once. Better Auth performs its own password hashing and creates both user and credential rows; the CLI performs no credential inserts or custom hashing.
5. Verify, in the same transaction, exactly one user and one account exist; their IDs, expected normalized email/name, `credential` provider, account ID and nonempty stored password agree; no sessions exist and the API returned no token. Any failed check aborts the transaction.
6. Commit only after verification. Exceptions/cancellation request rollback through Drizzle. Concurrent attempts either time out safely or acquire the lock after the first commit and see the existing user in a new READ COMMITTED statement snapshot. The CLI closes its pool on success and failure; connection attempts are bounded to 10 seconds, lock waits to 5 seconds, and individual transaction statements to 15 seconds.

### Evidence for transaction integration

Inspected installed sources for Better Auth 1.7.12:

- `better-auth/dist/api/routes/sign-up.mjs`: supported signup API, password hashing, credential linking, and `autoSignIn: false` behavior.
- `@better-auth/drizzle-adapter/dist/relations-v2/index.mjs`: adapter operations capture the supplied Drizzle object; with `transaction: false`, the adapter does not open an independent transaction.
- `@better-auth/core/dist/db/adapter/factory.mjs`: the disabled inner transaction wrapper invokes its callback with that same adapter.
- `drizzle-orm/node-postgres/session.js`: the outer transaction uses one checked-out client for BEGIN, callback queries, COMMIT/ROLLBACK and release.

Offline tests execute the **real signup API, default password hashing, adapter and Drizzle builders** over a scripted non-network driver. Pool-level queries are forbidden; tests establish that the lock, user lookup, user insertion, credential insertion, verification and commit/rollback requests all use the same transaction client, with no independent transaction or session insertion. A credential-insertion failure and failed post-create verification both request rollback on that client. The generated credential is verified using Better Auth's supported password verifier.

This demonstrates transaction routing with the pinned dependencies. It does **not** prove actual PostgreSQL persistence, lock scheduling, rollback, or concurrent-connection behavior. Those remain pending separately approved integration verification; repeat this compatibility review if Better Auth/Drizzle versions change.

## Safe failure diagnostics

The CLI reports a fixed stage label and sanitized category before its existing no-blind-retry warning. For example (illustration, not a diagnosis of a real run):

```text
Failed stage: Database connection. Category: TLS_CERTIFICATE_VERIFICATION.
Failed stage: Table locking. Category: TRANSACTION_CONTENTION. PostgreSQL code: 55P03.
```

Reported stages distinguish database checkout/connection, transaction initialization (BEGIN and SET LOCAL), auth table verification, table locking, existing-user check, Better Auth signup, credential verification, transaction commit, and connection cleanup. Configuration/credential failures before connection have their own input-validation stage. Idle-pool errors retain a safe diagnosis rather than being reduced to a generic cancellation.

Only explicitly allowlisted PostgreSQL SQLSTATE codes are printed. Known TLS, DNS, timeout, connection, cancellation and Better Auth rejections receive fixed categories. Unknown errors become `UNCLASSIFIED`; raw exception messages, stacks, certificate subjects/hostnames, API bodies, SQL, parameters and connection strings are never printed. Known precondition failures receive fixed explanatory hints, not forwarded exception messages. The original driver exception is not attached to the reported failure.

Drizzle's nested `cause` is inspected in a bounded walk to recover a code safely. Installed Drizzle checks out a connection before BEGIN: a wrapped query failure before the transaction callback is categorized as transaction initialization, while an unwrapped checkout/TLS failure is categorized as database connection. The transaction callback marks commit only after all verification and cancellation checks pass; it still uses the original transaction/locking protocol.

Better Auth can intentionally replace a failed user insert with a generic API rejection and discard its driver cause. Such failures report `Better Auth signup / AUTH_SIGNUP_REJECTED`, without inventing a PostgreSQL code. Secondary rollback errors may also be suppressed by the installed Drizzle implementation; diagnostics identify the original failing stage, not a guarantee that every cleanup error was observable.

### Session Pooler and TLS investigation

Supabase's documented Session Pooler uses the exact dashboard-supplied host, normally port 5432, and a project-qualified username such as `postgres.PROJECT_REF`. Session mode supports the transaction and session features used here. Do not substitute a direct-database username or another project's username, and do not automatically change the independently approved connection identity.

Offline tests construct (but never connect) the installed `pg` client to establish that a Session Pooler-shaped URL preserves host, port, database and project-qualified username and enables certificate verification for `sslmode=verify-full`. Installed `pg` source passes the hostname to TLS/SNI for server-identity validation. There is no demonstrated Session Pooler incompatibility in the transaction code.

A real TLS handshake still depends on network reachability, runtime trust roots, the server certificate chain, and hostname agreement. If the category is `TLS_CERTIFICATE_VERIFICATION`, have PM review the actual Bun runtime's trusted CA configuration and the approved hostname. Do not change to `sslmode=require`, use `rejectUnauthorized: false`, disable TLS validation, or add unapproved URL options to get past it. The CLI's existing URL option allowlist remains unchanged.

Other useful categories include `DATABASE_AUTHENTICATION` (review credentials and pooler username privately), `DATABASE_PERMISSION`/`AUTH_SCHEMA_MISMATCH` (review approved migration and role permissions), `TRANSACTION_CONTENTION` (stop other writers and inspect locks under separate approval), and `DATABASE_SERVER_ERROR`/`XX000` (generic server/pooler rejection, not proof of a specific cause).

The PM-reported empty user/account/session counts after a failed attempt establish that no owner persisted in that checked target. They do **not** identify which stage failed, establish a TLS cause, or prove a code/driver defect. An instrumented retry requires separate PM authorization; no provisioning attempt or database connection was made during diagnostic implementation.

## Failure and rerun policy

A successful run reports only that the owner/credential were verified and no bootstrap session was created. Subsequent runs must refuse the existing user.

On an uncertain connection/commit failure, **do not rerun blindly**. A lost commit acknowledgement may mean the owner exists even though the command failed. Request a separately approved database inspection. The script does not delete partial/existing accounts, repair data, adopt accounts, or automatically retry. Rollback/pool errors are not printed as raw objects.

After provisioning, PM must separately verify login, authenticated workspace access, logout, anonymous redirects and continued signup denial against that approved development target. These actions write session data and were not executed during implementation. Password reset/email delivery remain unconfigured by this task.

## Offline verification

```sh
bun test packages/auth/src/provision-owner.test.ts apps/web/scripts/provision-owner.test.ts packages/auth/src/index.test.ts
bun run check-types
bunx oxlint
bunx oxfmt --check apps/web/scripts apps/web/package.json packages/auth/src/provision-owner.ts packages/auth/src/provision-owner.test.ts docs/OWNER_PROVISIONING.md
```

Do not run the provisioning package command as a test. The tests import helpers without invoking the CLI entry point and replace all database driver connection/query functions before use; they never connect to a database or create an account in one.
