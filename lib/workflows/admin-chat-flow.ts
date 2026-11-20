/**
 * Durable admin-chat workflow.
 *
 * One run per admin turn. The route reads the admin memory file before it
 * starts the run and passes the text in, so the instructions are fixed for the
 * whole run and stay the same if the workflow replays. Tool calls (back-office
 * reads, sandbox bash, memory append) are durable steps with retries.
 */
import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { getWritable } from "workflow";
import type { ModelMessage } from "ai";
import { ADMIN_MODEL, buildAdminInstructions } from "@/lib/agent";
import { adminTools } from "@/lib/admin-tools";

export type AdminMemoryInput =
  | { status: "ok"; text: string }
  | { status: "empty" }
  | { status: "unavailable"; reason: string };

export async function adminChatFlow(
  messages: ModelMessage[],
  memory: AdminMemoryInput,
  today: string,
) {
  "use workflow";

  const agent = new WorkflowAgent({
    model: ADMIN_MODEL,
    instructions: buildAdminInstructions(memory, today),
    tools: adminTools,
  });

  await agent.stream({
    messages,
    writable: getWritable<ModelCallStreamPart>(),
  });
}
