import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { Writable, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  describeProvisioningFailure,
  ownerInput,
  provisionOwner,
  ProvisioningError,
  ProvisioningFailure,
  type ProvisioningStage,
  validateDevelopmentTarget,
} from "@solyn/auth/provision-owner";
import { createDb, type Database } from "@solyn/db";

// No environment loading or database activity on import (also used by offline
// prompt tests). The package command injects the validated env via Varlock.
export async function askQuestion(
  label: string,
  hidden: boolean,
  signal: AbortSignal,
  io: { input: Readable & { isTTY?: boolean }; output: Writable & { isTTY?: boolean } } = {
    input: process.stdin,
    output: process.stdout,
  },
) {
  if (!io.input.isTTY || !io.output.isTTY)
    throw new ProvisioningError(
      "Provisioning requires an interactive terminal; redirected credentials are not accepted.",
    );
  signal.throwIfAborted();
  const closed = new AbortController();
  // readline owns raw mode/editing, but ALL terminal echo/control output for a
  // password goes to a discarded stream. Nothing, including length, is echoed.
  const muted = hidden
    ? new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      })
    : undefined;
  const terminal = createInterface({
    input: io.input,
    output: muted ?? io.output,
    terminal: true,
    historySize: 0,
  });
  const cancel = () => closed.abort();
  terminal.on("SIGINT", cancel);
  terminal.on("close", cancel);
  try {
    if (hidden) io.output.write(label);
    return await terminal.question(hidden ? "" : label, {
      signal: AbortSignal.any([signal, closed.signal]),
    });
  } finally {
    terminal.close();
    terminal.off("SIGINT", cancel);
    terminal.off("close", cancel);
    muted?.end();
    if (hidden) io.output.write("\n");
  }
}

const uncertain =
  "Provisioning was not confirmed. Do not retry blindly: a connection or commit failure may be ambiguous. Request an approved database inspection before another attempt.";

async function main() {
  let database: Database | undefined;
  let input: { name: string; email: string; password: string } | undefined;
  let password = "",
    confirmation = "";
  let completed = false;
  let stage: ProvisioningStage = "input-validation";
  let poolFailure: ProvisioningFailure | undefined;
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  const onPoolError = (error: unknown) => {
    poolFailure = new ProvisioningFailure(
      completed ? "connection-cleanup" : "database-connection",
      error,
    );
    stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (process.argv.length > 2)
      throw new ProvisioningError(
        "This command accepts no arguments. Enter credentials only at its terminal prompts.",
      );
    const config = validateDevelopmentTarget(process.env);
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new ProvisioningError(
        "Run this command in an interactive terminal, without pipes or output redirection.",
      );
    const ask = (label: string, hidden = false) => askQuestion(label, hidden, cancellation.signal);
    const approval = await ask(
      "Confirm the exact development target is PM-approved and application writers are stopped. Type PROVISION DEVELOPMENT OWNER: ",
    );
    if (approval !== "PROVISION DEVELOPMENT OWNER")
      throw new ProvisioningError("Provisioning cancelled; confirmation did not match.");
    const name = await ask("Owner name: ");
    const email = await ask("Owner email: ");
    password = await ask("Owner password (8–128 characters; hidden): ", true);
    confirmation = await ask("Confirm password (hidden): ", true);
    if (password !== confirmation)
      throw new ProvisioningError("Passwords did not match; no database connection was opened.");
    input = { name, email: email.trim(), password };
    if (!ownerInput.safeParse(input).success)
      throw new ProvisioningError(
        "Invalid owner input. Use a name, valid email and an 8–128 character nonblank password.",
      );
    cancellation.signal.throwIfAborted();
    stage = "database-connection";
    database = createDb(config);
    // Set before the first checkout; Pool.options is the existing pg driver's
    // public configuration. Bound connection attempts without another DB layer.
    database.$client.options.connectionTimeoutMillis = 10_000;
    database.$client.on("error", onPoolError); // Retain only an allowlisted diagnosis.
    await provisionOwner(database, config, input, cancellation.signal);
    if (poolFailure) throw poolFailure;
    completed = true;
  } catch (error) {
    process.exitCode = 1;
    console.error(`${describeProvisioningFailure(poolFailure ?? error, stage)} ${uncertain}`);
  } finally {
    password = confirmation = "";
    if (input) input.password = "";
    try {
      await database?.$client.end();
      if (completed && poolFailure) {
        completed = false;
        process.exitCode = 1;
        console.error(
          `${describeProvisioningFailure(poolFailure, "connection-cleanup")} ${uncertain}`,
        );
      }
    } catch (error) {
      completed = false;
      process.exitCode = 1;
      console.error(`${describeProvisioningFailure(error, "connection-cleanup")} ${uncertain}`);
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (completed)
    console.log(
      "Owner provisioned and credential verified. No bootstrap session was created. Application public signup remains disabled.",
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(`${describeProvisioningFailure(error, "connection-cleanup")} ${uncertain}`);
  });
}
