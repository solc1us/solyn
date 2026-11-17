import "server-only";

import { headers } from "next/headers";

import { auth, db } from "../../services";
import { createWorkspaceService } from "./service";

// Every call revalidates the session from the current request. No client user IDs,
// module-level session state, cross-user cache, or auth configuration changes.
export const workspace = createWorkspaceService({
  db,
  getSession: async () => auth.api.getSession({ headers: await headers() }),
});
