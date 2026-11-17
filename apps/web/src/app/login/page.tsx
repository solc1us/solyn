"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

// Temporary verification UI; replace when Solyn's visual design is approved.
export default function LoginPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <main className="mx-auto max-w-sm space-y-4 p-6">
      <h1>Sign in</h1>
      <p>Access is limited to the provisioned owner account.</p>
      <form
        className="space-y-4"
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
            if (result.error) {
              setError("Unable to sign in. Check your credentials and try again.");
            } else {
              // Reload to discard any previously cached authenticated route state.
              window.location.assign("/dashboard");
            }
          } catch {
            setError("Sign in is unavailable. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
