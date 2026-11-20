"use client";

/**
 * Storefront shopping-agent chat panel.
 *
 * Uses `useChat` with `WorkflowChatTransport`, so the stream reconnects after
 * a refresh or dropped connection. The run id is kept in sessionStorage and
 * sent back on reload to resume the same workflow run. Tool results are shown
 * as product cards, order status, and a progress/failure line for each tool.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import Image from "next/image";
import Link from "next/link";
import { AlertCircle, Loader2, CheckCircle2, PackageSearch } from "lucide-react";
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
import { formatPrice } from "@/lib/format";
import type {
  ProductDetail,
  ProductSummary,
} from "@/lib/tools";

const RUN_ID_KEY = "shop-agent-run-id";
const MESSAGES_KEY = "shop-agent-messages";

const SUGGESTIONS = [
  "What hoodies do you have?",
  "Show me your categories",
  "I'd like to return an order",
];

type ToolOutput = {
  status?: string;
  message?: string;
  products?: ProductSummary[];
  categories?: { slug: string; name: string; productCount: number }[];
  product?: ProductDetail | null;
  stock?: { inStock: boolean; lowStock: boolean; units: number } | null;
  stockMessage?: string | null;
  orderId?: string;
  runId?: string | null;
};

const TOOL_LABELS: Record<string, string> = {
  searchProducts: "Searching the catalogue",
  getAllCategories: "Loading categories",
  getProductDetails: "Loading product details",
  returnOrder: "Starting your return",
};

const FAILURE_STATUSES = new Set([
  "not_found",
  "rejected",
  "invalid_input",
  "not_eligible",
]);

function ProductGrid({ products }: { products: ProductSummary[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2" aria-label="Search results">
      {products.map((p) => (
        <li key={p.id}>
          <Link
            href={`/products/${p.id}`}
            className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-foreground/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <div className="relative aspect-square bg-secondary">
              {p.image && (
                <Image
                  src={p.image}
                  alt={p.name}
                  fill
                  sizes="160px"
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              )}
            </div>
            <div className="p-2">
              <p className="text-sm font-medium leading-snug">{p.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatPrice(p.price, p.currency)}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ProductDetailCard({ detail, stock, stockMessage }: {
  detail: ProductDetail;
  stock: ToolOutput["stock"];
  stockMessage: string | null | undefined;
}) {
  const image = detail.images[0];
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex gap-3 p-3">
        <div className="relative size-24 shrink-0 overflow-hidden rounded-md bg-secondary">
          {image && (
            <Image src={image} alt={detail.name} fill sizes="96px" className="object-cover" />
          )}
        </div>
        <div className="min-w-0">
          <p className="font-medium leading-snug">{detail.name}</p>
          <p className="text-sm text-muted-foreground">
            {formatPrice(detail.price, detail.currency)}
          </p>
          <p className="mt-1 text-xs">
            {stock ? (
              stock.inStock ? (
                stock.lowStock ? `Only ${stock.units} left` : "In stock"
              ) : (
                "Out of stock"
              )
            ) : (
              stockMessage ?? "Stock unavailable"
            )}
          </p>
        </div>
      </div>
      <p className="px-3 text-sm text-muted-foreground line-clamp-4">
        {detail.description}
      </p>
      <div className="p-3">
        <Link
          href={`/products/${detail.id}`}
          className="text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          View product
        </Link>
      </div>
    </div>
  );
}

function ToolPart({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;
  const output = part.state === "output-available" ? (part.output as ToolOutput) : undefined;

  if (part.state === "output-error") {
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {label} failed. Please try again.
      </div>
    );
  }
  if (part.state !== "output-available" || !output) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}…
      </div>
    );
  }

  if (name === "searchProducts") {
    if (output.status === "ok" && output.products) {
      return <ProductGrid products={output.products} />;
    }
    return <StatusLine status={output.status} message={output.message} />;
  }

  if (name === "getProductDetails") {
    if (output.status === "ok" && output.product) {
      return (
        <ProductDetailCard
          detail={output.product}
          stock={output.stock ?? null}
          stockMessage={output.stockMessage}
        />
      );
    }
    return <StatusLine status={output.status} message={output.message} />;
  }

  if (name === "getAllCategories") {
    if (output.categories && output.categories.length > 0) {
      return (
        <ul className="flex flex-wrap gap-2" aria-label="Categories">
          {output.categories.map((c) => (
            <li key={c.slug}>
              <Link
                href={`/search?category=${encodeURIComponent(c.slug)}`}
                className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                {c.name} ({c.productCount})
              </Link>
            </li>
          ))}
        </ul>
      );
    }
    return <StatusLine status={output.status} message="No categories are available right now." />;
  }

  if (name === "returnOrder") {
    if (output.status === "filed") {
      return (
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden="true" />
          <span>
            Your return for order <strong>{output.orderId}</strong> is filed. We&apos;ll
            email you updates. Your refund is pre-authorised, not yet paid.
          </span>
        </div>
      );
    }
    return <StatusLine status={output.status} message={output.message} />;
  }

  return null;
}

function StatusLine({ status, message }: { status?: string; message?: string }) {
  const failed = status ? FAILURE_STATUSES.has(status) : false;
  return (
    <div
      role={failed ? "alert" : "status"}
      className={`flex items-center gap-2 text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}
    >
      {failed ? (
        <AlertCircle className="size-4" aria-hidden="true" />
      ) : (
        <PackageSearch className="size-4" aria-hidden="true" />
      )}
      {message ?? "Nothing to show."}
    </div>
  );
}

export function AgentChat() {
  const [input, setInput] = useState("");
  const [initialRunId, setInitialRunId] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  // sessionStorage is read after mount, so the server render matches the first client render.
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

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: "/api/chat",
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
    onError: () => {
      // The error is shown from `error`; the run id stays so a refresh can resume.
    },
  });

  // Persist conversation so a refresh still shows the history.
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
              Ask me to find products, check details, or start a return.
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
              The agent could not respond. Please try again.
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
              placeholder="Ask about products or returns"
              aria-label="Message the shopping agent"
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
