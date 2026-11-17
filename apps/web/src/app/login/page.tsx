"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <main className="login-page">
      <div className="login-intro">
        <span className="wordmark" translate="no">
          solyn<span>.</span>
        </span>
        <h1>Clarity for everything you’re working on.</h1>
        <p>
          Your projects, your notes, and the context that connects them. A quiet place to keep it
          all together.
        </p>
        <span className="login-caption">Your personal knowledge workspace</span>
      </div>
      <section className="surface login-panel" aria-labelledby="login-heading">
        <div className="login-panel-heading">
          <h2 id="login-heading">Welcome back</h2>
          <p>Sign in to your workspace.</p>
        </div>
        <form
          className="login-form"
          aria-busy={pending}
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            const data = new FormData(event.currentTarget);
            setPending(true);
            setError("");
            try {
              const result = await authClient.signIn.email({
                email: String(data.get("email")),
                password: String(data.get("password")),
              });
              if (result.error)
                setError("Unable to sign in. Check your email and password, then try again.");
              else window.location.assign("/dashboard");
            } catch {
              setError("Sign in is unavailable. Check your connection and try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <fieldset disabled={pending} className="form-fields">
            <div className="field">
              <Label htmlFor="email">Email</Label>
              <Input
                className="form-control"
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="you@example.com"
                required
              />
            </div>
            <div className="field">
              <Label htmlFor="password">Password</Label>
              <Input
                className="form-control"
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
          </fieldset>
          {error ? (
            <p className="feedback feedback-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="control login-submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="login-access">A private workspace. Sign in with your existing account.</p>
      </section>
    </main>
  );
}
