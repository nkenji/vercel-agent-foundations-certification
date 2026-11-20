/**
 * Admin-only Vercel Sandbox: persistent memory file, back-office data
 * snapshots for joins/aggregates, and the `bash` runner.
 *
 * The sandbox is named and persistent, so the memory file and data snapshots
 * survive between admin conversations. It never receives the store bypass
 * secret or the admin password: nothing is passed in its environment, and any
 * output is redacted before it is returned to the model.
 *
 * Only the admin agent can reach this module. The shopping agent's tool set
 * does not include anything from here.
 */
import { Sandbox } from "@vercel/sandbox";
import { ADMIN_PASSWORD } from "@/lib/admin-auth";

export const ADMIN_SANDBOX_NAME = "ship-shop-admin";
export const MEMORY_PATH = "/vercel/sandbox/memory/admin-memory.md";
export const DATA_DIR = "/vercel/sandbox/data";
const MAX_MEMORY_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 6_000;
const BASH_TIMEOUT_MS = 30_000;

export type MemoryState =
  | { status: "ok"; text: string }
  | { status: "empty" }
  | { status: "unavailable"; reason: string };

export async function getAdminSandbox(): Promise<Sandbox> {
  return Sandbox.getOrCreate({
    name: ADMIN_SANDBOX_NAME,
    persistent: true,
    runtime: "node24",
    onCreate: async (sandbox) => {
      await sandbox.runCommand("mkdir", ["-p", "/vercel/sandbox/memory", DATA_DIR]);
      // Created empty on purpose: an empty file means "no notes yet".
      await sandbox.writeFiles([{ path: MEMORY_PATH, content: "" }]);
    },
  });
}

/** Removes the admin secrets from any text before it reaches the model. */
export function redact(text: string): string {
  const secrets = [process.env.BYPASS_SECRET, ADMIN_PASSWORD].filter(
    (value): value is string => typeof value === "string" && value.length >= 6,
  );
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

/**
 * Reads the memory file for the start of an admin conversation. Never throws:
 * if the sandbox is unreachable the agent is told memory is unavailable, so it
 * does not assume there are no notes.
 */
export async function readAdminMemory(): Promise<MemoryState> {
  try {
    const sandbox = await getAdminSandbox();
    const buffer = await sandbox.readFileToBuffer({ path: MEMORY_PATH });
    const text = buffer ? buffer.toString("utf8").trim() : "";
    if (!text) return { status: "empty" };
    const clipped =
      text.length > MAX_MEMORY_CHARS
        ? `[older notes truncated]\n${text.slice(-MAX_MEMORY_CHARS)}`
        : text;
    return { status: "ok", text: redact(clipped) };
  } catch (err) {
    console.error("[admin-memory] read failed", err);
    return { status: "unavailable", reason: "The memory store could not be reached." };
  }
}

/** Appends one dated note to the memory file. Caller validates the note. */
export async function appendAdminMemory(note: string): Promise<{ savedAt: string }> {
  const sandbox = await getAdminSandbox();
  const buffer = await sandbox.readFileToBuffer({ path: MEMORY_PATH });
  const existing = buffer ? buffer.toString("utf8") : "";
  const savedAt = new Date().toISOString();
  const line = `- ${savedAt}: ${note.replace(/\s+/g, " ").trim()}\n`;
  const next = existing && !existing.endsWith("\n") ? `${existing}\n${line}` : `${existing}${line}`;
  await sandbox.writeFiles([{ path: MEMORY_PATH, content: next }]);
  return { savedAt };
}

/**
 * Runs a shell command in the admin sandbox. A non-zero exit is a normal
 * result, not an error. A timeout or dropped command is reported as a failed
 * run so the UI can show it. Creating the sandbox itself throws, so the
 * surrounding step retries.
 */
export async function runAdminBash(command: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const sandbox = await getAdminSandbox();
  try {
    const result = await sandbox.runCommand("bash", ["-lc", command], {
      timeoutMs: BASH_TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    return {
      exitCode: result.exitCode,
      stdout: truncate(redact(stdout)),
      stderr: truncate(redact(stderr)),
      timedOut: false,
    };
  } catch (err) {
    console.error("[admin-bash] command did not finish", err);
    const timedOut = err instanceof Error && /timeout|timed out/i.test(err.message);
    return {
      exitCode: null,
      stdout: "",
      stderr: timedOut
        ? "The command timed out after 30 seconds."
        : "The command did not finish. Try a smaller query.",
      timedOut,
    };
  }
}

/** Replaces the data snapshot files so bash can join them. */
export async function writeAdminSnapshots(
  files: Record<string, unknown[]>,
): Promise<void> {
  const sandbox = await getAdminSandbox();
  await sandbox.runCommand("mkdir", ["-p", DATA_DIR]);
  await sandbox.writeFiles(
    Object.entries(files).map(([name, rows]) => ({
      path: `${DATA_DIR}/${name}`,
      content: JSON.stringify(rows, null, 2),
    })),
  );
}
