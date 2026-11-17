"use client";

import { Button } from "@solyn/ui/components/button";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export default function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="space-y-2">
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            const result = await authClient.signOut();
            if (result.error) {
              setError("Unable to sign out. Please try again.");
            } else {
              window.location.assign("/login");
            }
          } catch {
            setError("Sign out is unavailable. Please try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Signing out..." : "Sign out"}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
