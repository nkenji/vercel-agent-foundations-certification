/**
 * Reconnect to an admin-chat run. Requires the admin cookie.
 * Same replay approach as the shopping route: replay raw parts from 0 and let
 * the transform skip the UI chunks the client already has.
 */
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";
import { isAdminRequest, unauthorized } from "@/lib/admin-guard";

export const maxDuration = 300;

const RUN_ID_PATTERN = /^wrun_[A-Za-z0-9]+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAdminRequest())) return unauthorized();

  const { id } = await params;
  if (!RUN_ID_PATTERN.test(id)) {
    return Response.json({ error: "Unknown chat run." }, { status: 404 });
  }

  const startIndex = Number(new URL(request.url).searchParams.get("startIndex") ?? "0");
  if (!Number.isInteger(startIndex)) {
    return Response.json({ error: "startIndex must be an integer." }, { status: 400 });
  }

  const run = getRun(id);
  if (!(await run.exists)) {
    return Response.json({ error: "Unknown chat run." }, { status: 404 });
  }
  const status = await run.status;
  if (status === "failed" || status === "cancelled") {
    return Response.json({ error: `Chat run ${status}.` }, { status: 410 });
  }

  const readable = run.getReadable({ startIndex: 0 });
  const tailIndex = await readable.getTailIndex();

  return createUIMessageStreamResponse({
    stream: readable.pipeThrough(
      createModelCallToUIChunkTransform({ uiStartIndex: Math.max(0, startIndex) }),
    ),
    headers: {
      "x-workflow-run-id": id,
      "x-workflow-stream-tail-index": String(tailIndex),
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
