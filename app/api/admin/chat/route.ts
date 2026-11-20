/**
 * Admin-chat endpoint. Requires the admin cookie.
 *
 * Reads the admin memory file, starts the durable admin workflow with it, and
 * streams the result. The run id is returned in `x-workflow-run-id` so the
 * client can reconnect through /api/admin/chat/[id]/stream.
 */
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { convertToModelMessages, createUIMessageStreamResponse, type UIMessage } from "ai";
import { start } from "workflow/api";
import { isAdminRequest, unauthorized } from "@/lib/admin-guard";
import { readAdminMemory } from "@/lib/admin-sandbox";
import { adminChatFlow } from "@/lib/workflows/admin-chat-flow";

export const maxDuration = 300;

const MAX_MESSAGES = 50;

export async function POST(request: Request): Promise<Response> {
  if (!(await isAdminRequest())) return unauthorized();

  let body: { messages?: unknown };
  try {
    body = (await request.json()) as { messages?: unknown };
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array." }, { status: 400 });
  }
  if (body.messages.length > MAX_MESSAGES) {
    return Response.json(
      { error: `Conversation is limited to ${MAX_MESSAGES} messages.` },
      { status: 413 },
    );
  }

  const messages = await convertToModelMessages(body.messages as UIMessage[]);

  // Memory is read once per turn by app code and handed to the agent. An empty
  // or unreachable file is passed through as such, never as an error.
  const memory = await readAdminMemory();
  const today = new Date().toISOString().slice(0, 10);

  const run = await start(adminChatFlow, [messages, memory, today]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: {
      "x-workflow-run-id": run.runId,
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
