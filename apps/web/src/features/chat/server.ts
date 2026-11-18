import "server-only";

import { headers } from "next/headers";

import { auth, db } from "../../services";
import { createChatService } from "./service";

// Fresh request session on every operation, never client/model-provided identity.
// No routes, Server Actions, provider calls or cross-request session caches here.
export const chat = createChatService({
  db,
  getSession: async () => auth.api.getSession({ headers: await headers() }),
});
