import { createGroq } from "@ai-sdk/groq";

import { ENV } from "@/env.server";
import { chat } from "@/features/chat/server";
import { CHAT_MODEL_ID, createChatStreamHandler } from "@/features/chat/stream-handler";
import { workspace } from "@/features/workspace/server";
import { auth } from "@/services";

export const runtime = "nodejs";
export const maxDuration = 180;

export const POST = createChatStreamHandler({
  chat,
  workspace,
  getSession: async (request) => auth.api.getSession({ headers: request.headers }),
  getApiKey: () => ENV.GROQ_API_KEY,
  origin: ENV.BETTER_AUTH_URL,
  model: (apiKey) => createGroq({ apiKey })(CHAT_MODEL_ID),
});
