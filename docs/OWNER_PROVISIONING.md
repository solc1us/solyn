# Controlled initial owner provisioning — PM review required

## Current behavior

The application uses Better Auth 1.7.12 with its existing Drizzle PostgreSQL adapter. Email/password login and logout remain enabled; `emailAndPassword.disableSignUp: true` rejects public registration, including direct API requests. There is no signup page or bootstrap HTTP endpoint.

No account has been created by this task. No provisioning script is shipped yet: safely enforcing a one-owner bootstrap requires a database transaction, an empty-user-table check, and concurrency control against the approved target. These cannot be verified without separately approved database operations.

## Supported mechanism inspected

Installed source: `better-auth/dist/api/routes/sign-up.mjs` and `@better-auth/core/dist/types/init-options.d.mts` (both 1.7.12).

- `disableSignUp` is a supported email/password configuration option, not a UI-only restriction.
- It also blocks server-side `auth.api.signUpEmail`; calling the normal application's API is not a bootstrap bypass.
- The supported `auth.api.signUpEmail({ body: { name, email, password } })` flow normalizes email, checks duplicates, hashes the password through Better Auth, creates the user and credential account, and optionally creates a session.
- Existing unique email protection prevents duplicate emails, but does not prevent two differently named owner accounts. A separate empty-table check without a lock is insufficient.

## Recommended procedure (not executed; approve before implementation/use)

1. PM identifies and approves the exact separate development database and owner email. Confirm the expected auth schema is already installed; any missing schema/migration is a separate approval gate. Do not use `db:push` as bootstrap preparation.
2. Stop application writers and other provisioning processes. Use a trusted local administrative shell; do not expose a provisioning web endpoint. Do not change the deployed application's disabled-registration setting.
3. Prepare a one-shot local script, reviewed before execution, using existing dependencies only. Load credentials from the approved environment and obtain the owner's name/email and password through a non-echoing prompt or approved secret manager. Never put a password in source, shell arguments/history, logs, or committed environment files.
4. Begin a PostgreSQL transaction and acquire an exclusive lock on the auth `user` table before checking its contents. Abort if **any** user exists, even if its email differs from the requested owner. Do not overwrite, delete, or automatically adopt an existing account. All concurrent bootstrap attempts must follow this locking protocol; unrelated writers must remain stopped.
5. Within that same transaction, construct a local-only Better Auth instance using the transaction-bound Drizzle adapter, the existing schema, and `emailAndPassword: { enabled: true, disableSignUp: false, autoSignIn: false }`. Do not mount its handler or use Next.js cookie integration. Invoke `auth.api.signUpEmail` once with the secret input. Use the supported public API, not internal adapter methods or manual password rows.
6. Verify within the transaction that exactly one expected user and its linked `credential` account exist and no bootstrap session was created. Commit only on success; roll back all writes on failure. Review the transaction-bound adapter integration against installed Drizzle/Better Auth versions before execution. Do not log returned user objects, tokens, hashes, or input secrets.
7. Dispose of the temporary instance and secret inputs. Resume the application with public signup still disabled. Verify owner login, authenticated `/dashboard`, logout, subsequent anonymous redirect, and signup denial against that approved development target. Login/logout themselves write session data and require approval for this target.
8. Retain only a non-secret execution record. Reruns must abort because a user now exists. If an earlier run is ambiguous, inspect under a new explicit approval rather than retrying blindly.

## Remaining approval and verification

PM must approve the exact target, owner identity, transaction/locking implementation, and one-time write execution. Successful password login, session persistence/revocation, and provisioning atomicity have not been exercised against a database. Do not temporarily enable signup on the deployed application, add a public bootstrap route, introduce an admin plugin, or insert plaintext passwords.

Existing databases have not been inspected. Disabling registration neither removes existing accounts nor limits login to a single email; review pre-existing accounts before relying on the single-owner assumption. Password reset/email delivery are not configured by this task.
