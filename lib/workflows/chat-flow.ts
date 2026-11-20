/**
 * Durable shopping-chat workflow.
 *
 * One run per chat conversation. The model loop and every tool call run inside
 * the workflow, and each tool is its own durable step with retries. Output is
 * written to the run's writable stream, which the route converts to UI chunks.
 * If the browser disconnects, the client reconnects to this same run.
 */
import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { getWritable } from "workflow";
import type { ModelMessage } from "ai";
import { SHOPPING_INSTRUCTIONS, SHOPPING_MODEL } from "@/lib/agent";
import { shoppingTools } from "@/lib/tools";

export async function shoppingChatFlow(messages: ModelMessage[]) {
  "use workflow";

  const agent = new WorkflowAgent({
    model: SHOPPING_MODEL,
    instructions: SHOPPING_INSTRUCTIONS,
    tools: shoppingTools,
  });

  await agent.stream({
    messages,
    writable: getWritable<ModelCallStreamPart>(),
  });
}
