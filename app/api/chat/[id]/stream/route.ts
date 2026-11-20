/**
 * Reconnect to an in-flight or finished shopping-chat run.
 *
 * `startIndex` counts UI chunks already received. The workflow stream is
 * replayed from the start and `createModelCallToUIChunkTransform` drops the
 * chunks the client already has. That avoids duplicate text after a refresh.
 */
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

export const maxDuration = 300;

const RUN_ID_PATTERN = /^wrun_[A-Za-z0-9]+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!RUN_ID_PATTERN.test(id)) {
    return Response.json({ error: "Unknown chat run." }, { status: 404 });
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("startIndex") ?? "0";
  const startIndex = Number(raw);
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

  // Replay the raw stream from 0 and let the transform skip what the client
  // already has. startIndex counts UI chunks, not raw stream parts, so it must
  // not be passed to getReadable.
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
