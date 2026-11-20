/**
 * Shopping-chat endpoint.
 *
 * Starts the durable chat workflow and returns its output as a UI message
 * stream. The run id goes back in `x-workflow-run-id`, so the client can
 * reconnect after a refresh or dropped connection.
 */
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { convertToModelMessages, createUIMessageStreamResponse, type UIMessage } from "ai";
import { start } from "workflow/api";
import { shoppingChatFlow } from "@/lib/workflows/chat-flow";

export const maxDuration = 300;

const MAX_MESSAGES = 50;

export async function POST(request: Request): Promise<Response> {
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

  const run = await start(shoppingChatFlow, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: {
      "x-workflow-run-id": run.runId,
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
