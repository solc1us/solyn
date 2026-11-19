import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@solyn/db";
import * as schema from "@solyn/db/schema/auth";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
};

export function createAuth(env: AuthConfig, database: Database) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: { enabled: true, disableSignUp: true },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    logger: {
      // Leave level unset to retain Better Auth's default warn/error policy.
      // Never forward arbitrary messages or extra arguments (including causes).
      log(level, message) {
        const category =
          message === "INTERNAL_SERVER_ERROR" ? "INTERNAL_SERVER_ERROR" : "AUTH_EVENT";
        switch (level) {
          case "error":
            console.error(`[Better Auth] ERROR ${category}`);
            break;
          case "warn":
            console.warn(`[Better Auth] WARN ${category}`);
            break;
          case "info":
            console.log(`[Better Auth] INFO ${category}`);
            break;
          case "debug":
            console.debug(`[Better Auth] DEBUG ${category}`);
            break;
        }
      },
    },
    plugins: [nextCookies()],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
