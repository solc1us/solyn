import { createAuth } from "@solyn/auth";
import { createDb } from "@solyn/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
