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
    <main className="login-page mx-auto grid min-h-svh max-w-[1200px] grid-cols-[minmax(0,1fr)_minmax(0,430px)] items-center gap-[100px] px-[48px] py-[72px] [@media(max-width:1100px)]:gap-[48px] [@media(max-width:760px)]:max-w-[490px] [@media(max-width:760px)]:grid-cols-[minmax(0,1fr)] [@media(max-width:760px)]:gap-[32px] [@media(max-width:760px)]:px-[24px] [@media(max-width:760px)]:py-[40px]">
      <div className="login-intro pb-[30px] [@media(max-width:760px)]:p-0">
        <span
          className="wordmark text-[30px] leading-none font-[650] tracking-[-0.065em]"
          translate="no"
        >
          solyn<span className="text-[#4f7cff]">.</span>
        </span>
        <h1 className="mt-[60px] max-w-[480px] text-[clamp(32px,3.3vw,46px)] leading-[1.16] font-[550] tracking-[-0.045em] text-balance [@media(max-width:760px)]:mt-[32px] [@media(max-width:760px)]:text-[32px]">
          Clarity for everything you’re working on.
        </h1>
        <p className="mt-[24px] max-w-[390px] text-[16px] leading-[1.8] text-[#a8b5d0] [@media(max-width:760px)]:mt-[14px] [@media(max-width:760px)]:text-[14px]">
          Your projects, your notes, and the context that connects them. A quiet place to keep it
          all together.
        </p>
        <span className="login-caption mt-[70px] block text-[12px] text-[#a8b5d0] [@media(max-width:760px)]:hidden">
          Your personal knowledge workspace
        </span>
      </div>
      <section
        className="login-panel rounded-[12px] border border-border bg-canvas p-[36px] shadow-[0_20px_80px_#03091455] [@media(max-width:760px)]:px-[24px] [@media(max-width:760px)]:py-[28px]"
        aria-labelledby="login-heading"
      >
        <div className="login-panel-heading">
          <h2 id="login-heading" className="text-[24px]">
            Welcome back
          </h2>
          <p className="mt-[7px] text-[#a8b5d0]">Sign in to your workspace.</p>
        </div>
        <form
          className="login-form mt-[30px]"
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
          <fieldset disabled={pending} className="form-fields grid gap-[20px]">
            <div className="field grid gap-[9px]">
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
            <div className="field grid gap-[9px]">
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
            <p
              className="mt-[22px] rounded-[7px] border border-[#71404c] bg-[#342333] px-[16px] py-[14px] text-[14px] text-[#ffd2d7]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            className="control login-submit mt-[28px] w-full"
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="login-access mt-[27px] border-t border-border pt-[25px] text-[12px] text-[#a8b5d0]">
          A private workspace. Sign in with your existing account.
        </p>
      </section>
    </main>
  );
}
