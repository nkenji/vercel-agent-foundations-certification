"use client";

/**
 * Admin agent chat panel (/admin).
 *
 * `useChat` + `WorkflowChatTransport` against /api/admin/chat, so a refresh
 * reconnects to the same run. Each tool call shows a running, done or failed
 * state, and `bash` shows the command, its output and any error text.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import { AlertCircle, CheckCircle2, Loader2, Terminal } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";

const RUN_ID_KEY = "admin-agent-run-id";
const MESSAGES_KEY = "admin-agent-messages";

const SUGGESTIONS = [
  "Show me low-stock items",
  "What were the top sellers in the last 30 days?",
  "Summarize this week's revenue",
  "Which returns are still pending, and what do open tickets say about them?",
];

const TOOL_LABELS: Record<string, string> = {
  getSupportTickets: "Reading support tickets",
  getReturnsHistory: "Reading returns history",
  getInventoryStock: "Reading inventory",
  getSalesAnalytics: "Reading sales analytics",
  searchCatalog: "Searching the catalogue",
  getCategories: "Loading categories",
  loadBackOfficeData: "Loading data into the sandbox",
  bash: "Running a command in the sandbox",
  appendMemory: "Saving a note to memory",
};

type AdminToolOutput = {
  status?: string;
  summary?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

const FAILED = new Set(["failed", "not_found", "rejected", "invalid_input"]);

function BashPanel({
  command,
  state,
  output,
}: {
  command: string | undefined;
  state: "running" | "done" | "error";
  output: AdminToolOutput | undefined;
}) {
  const failed = state === "error" || (output?.status !== undefined && FAILED.has(output.status));
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card text-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Terminal className="size-4" aria-hidden="true" />
        <span className="font-medium">Sandbox command</span>
        {state === "running" && (
          <span role="status" className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Running…
          </span>
        )}
        {state !== "running" && failed && (
          <span role="alert" className="ml-auto flex items-center gap-1 text-destructive">
            <AlertCircle className="size-3.5" aria-hidden="true" />
            Failed{output?.exitCode != null ? ` (exit ${output.exitCode})` : ""}
          </span>
        )}
        {state === "done" && !failed && (
          <span className="ml-auto flex items-center gap-1 text-emerald-700">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Done
          </span>
        )}
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs" aria-label="Command">
        <code>$ {command ?? "…"}</code>
      </pre>
      {state === "error" && (
        <p className="border-t border-border px-3 py-2 text-xs text-destructive">
          The sandbox command could not be run. Please try again.
        </p>
      )}
      {output?.stdout ? (
        <pre
          className="max-h-60 overflow-auto border-t border-border bg-muted/40 px-3 py-2 text-xs"
          aria-label="Command output"
          tabIndex={0}
        >
          {output.stdout}
        </pre>
      ) : null}
      {output?.stderr ? (
        <pre
          className="max-h-40 overflow-auto border-t border-border px-3 py-2 text-xs text-destructive"
          aria-label="Command errors"
          tabIndex={0}
        >
          {output.stderr}
        </pre>
      ) : null}
    </div>
  );
}

function ToolPart({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;
  const output =
    part.state === "output-available" ? (part.output as AdminToolOutput) : undefined;
  const input = part.input as { command?: string } | undefined;

  if (name === "bash") {
    const state =
      part.state === "output-error" ? "error" : output ? "done" : "running";
    return <BashPanel command={input?.command} state={state} output={output} />;
  }

  if (part.state === "output-error") {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {label} failed. Please try again.
      </div>
    );
  }
  if (!output) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}…
      </div>
    );
  }
  const failed = output.status ? FAILED.has(output.status) : false;
  return (
    <div
      role={failed ? "alert" : undefined}
      className={`flex items-center gap-2 text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}
    >
      {failed ? (
        <AlertCircle className="size-4" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
      )}
      <span>{output.summary ?? `${label}: done`}</span>
    </div>
  );
}

export function AdminAgentChat() {
  const [input, setInput] = useState("");
  const [initialRunId, setInitialRunId] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: "/api/admin/chat",
        onChatSendMessage: (response) => {
          const runId = response.headers.get("x-workflow-run-id");
          if (runId) sessionStorage.setItem(RUN_ID_KEY, runId);
        },
        onChatEnd: () => {
          sessionStorage.removeItem(RUN_ID_KEY);
        },
      }),
    [],
  );

  const { messages, setMessages, sendMessage, status, error, clearError } = useChat({
    transport,
    resume: ready && Boolean(initialRunId),
  });

  // sessionStorage is read after mount so the server render matches the first client render.
  useEffect(() => {
    const saved = sessionStorage.getItem(MESSAGES_KEY);
    if (saved) {
      try {
        setMessages(JSON.parse(saved) as UIMessage[]);
      } catch {
        sessionStorage.removeItem(MESSAGES_KEY);
      }
    }
    setInitialRunId(sessionStorage.getItem(RUN_ID_KEY) ?? undefined);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      clearError();
      sendMessage({ text: trimmed });
      setInput("");
    },
    [busy, clearError, sendMessage],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    send(message.text ?? "");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="flex-1" aria-live="polite">
        <ConversationContent>
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask about tickets, returns, stock or sales. I can read the back office but not
              change anything.
            </p>
          )}
          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return <MessageResponse key={i}>{part.text}</MessageResponse>;
                  }
                  if (isToolUIPart(part)) {
                    return <ToolPart key={i} part={part} />;
                  }
                  return null;
                })}
              </MessageContent>
            </Message>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              The admin agent could not respond
              {error.message.includes("401") ? ". Please sign in again." : ". Please try again."}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex flex-col gap-3 border-t p-3">
        {messages.length === 0 && (
          <Suggestions>
            {SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={send} />
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              placeholder="Ask the admin agent…"
              aria-label="Message the admin agent"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit status={status} disabled={!input.trim() || busy} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
