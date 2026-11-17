import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import { askQuestion } from "./provision-owner";

function terminal() {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(value: boolean) {
      raw.push(value);
      return this;
    },
  });
  let printed = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        printed += chunk.toString();
        done();
      },
    }),
    { isTTY: true },
  );
  return { input, output, raw, printed: () => printed };
}

test("hidden password and confirmation prompts never echo input and restore terminal mode", async () => {
  const io = terminal();
  const signal = new AbortController().signal;
  const password = "offline-only-password";
  for (const label of ["Password: ", "Confirm: "]) {
    const answer = askQuestion(label, true, signal, io);
    io.input.write(password + "\r");
    assert.equal(await answer, password);
    assert.ok(!io.printed().includes(password));
    assert.equal(io.raw.at(-1), false);
    // readline retains a reusable keypress decoder, but closes its consumer and pauses input.
    assert.equal(io.input.isPaused(), true);
    assert.equal(io.input.listenerCount("keypress"), 0);
  }
  assert.equal(io.printed(), "Password: \nConfirm: \n");
});

test("Ctrl-C cancels hidden input without printing the partially typed password", async () => {
  const io = terminal();
  const answer = askQuestion("Password: ", true, new AbortController().signal, io);
  io.input.write("partial-secret\x03");
  await assert.rejects(answer, { name: "AbortError" });
  assert.equal(io.printed(), "Password: \n");
  assert.equal(io.raw.at(-1), false);
  assert.equal(io.input.isPaused(), true);
  assert.equal(io.input.listenerCount("keypress"), 0);
});

test("EOF and external cancellation clean up hidden prompts", async () => {
  for (const mode of ["eof", "abort"]) {
    const io = terminal();
    const controller = new AbortController();
    const answer = askQuestion("Password: ", true, controller.signal, io);
    if (mode === "eof") io.input.end();
    else controller.abort();
    await assert.rejects(answer, { name: "AbortError" });
    assert.equal(io.raw.at(-1), false);
    assert.equal(io.printed(), "Password: \n");
  }
});

test("noninteractive input is refused before reading credentials", async () => {
  const io = terminal();
  io.input.isTTY = false;
  await assert.rejects(
    askQuestion("Password: ", true, new AbortController().signal, io),
    /interactive terminal/,
  );
  assert.equal(io.printed(), "");
  assert.equal(io.raw.length, 0);
});
