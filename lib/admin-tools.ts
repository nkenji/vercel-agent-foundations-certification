/**
 * Tools for the admin agent. The shopping agent never receives these.
 *
 * Every `execute` is a `"use step"` function, so each back-office read, sandbox
 * command and memory write is its own durable step and is retried on transient
 * failures. Every result has a `status` and a plain `summary` sentence. Money
 * is returned in integer cents plus a formatted string, and the summary states
 * the date window used.
 *
 * Read-only: nothing here changes inventory, tickets, orders or refunds. The
 * only write is the admin memory note.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getBackOfficeReturns,
  getBackOfficeSales,
  getBackOfficeStock,
  getBackOfficeSupportTickets,
  getCategories,
  getProducts,
} from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { clientFailure } from "@/lib/tool-errors";
import {
  appendAdminMemory,
  redact,
  runAdminBash,
  writeAdminSnapshots,
} from "@/lib/admin-sandbox";

// The back-office API does not return a currency for returns, so refunds are
// shown in USD. The agent instructions tell the model to say so.
const REPORT_CURRENCY = "USD";

const isoDate = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe("Start or end date as YYYY-MM-DD or ISO 8601.");

function badDate(...values: (string | undefined)[]): boolean {
  return values.some((v) => v !== undefined && Number.isNaN(Date.parse(v)));
}

const INVALID_DATE_SUMMARY = "Dates must be YYYY-MM-DD or ISO 8601, for example 2026-11-01.";

function failure(err: unknown): { status: "not_found" | "rejected"; summary: string } {
  const f = clientFailure(err);
  return { status: f.status, summary: f.message };
}

// ---------------------------------------------------------------------------
// getSupportTickets
// ---------------------------------------------------------------------------

const getSupportTicketsInput = z.object({
  from: isoDate,
  to: isoDate,
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  category: z
    .enum(["shipping", "returns", "product_quality", "sizing", "billing", "payment", "account", "other"])
    .optional(),
  assignee: z.string().trim().min(1).max(60).optional().describe("Staff username."),
  limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
});

async function getSupportTicketsStep(input: z.infer<typeof getSupportTicketsInput>) {
  "use step";
  if (badDate(input.from, input.to)) {
    return { status: "invalid_input" as const, summary: INVALID_DATE_SUMMARY, tickets: [] };
  }
  try {
    const { data, meta } = await getBackOfficeSupportTickets({
      from: input.from,
      to: input.to,
      status: input.status,
      priority: input.priority,
      category: input.category,
      assignee: input.assignee,
      limit: input.limit ?? 25,
    });
    const tickets = data.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.category,
      relatedOrderId: t.relatedOrderId,
      assignee: t.assignee,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    return {
      status: tickets.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `${tickets.length} ticket(s) between ${meta.from} and ${meta.to}.`,
      window: { from: meta.from, to: meta.to },
      tickets,
    };
  } catch (err) {
    return { ...failure(err), tickets: [] };
  }
}

export const getSupportTickets = tool({
  description:
    "List support tickets, filtered by date window, status, priority, category or assignee. Read-only: this cannot resolve or assign tickets.",
  inputSchema: getSupportTicketsInput,
  execute: getSupportTicketsStep,
});

// ---------------------------------------------------------------------------
// getReturnsHistory
// ---------------------------------------------------------------------------

const getReturnsHistoryInput = z.object({
  from: isoDate,
  to: isoDate,
  status: z.enum(["pending", "processing", "completed"]).optional(),
  decision: z.enum(["approved", "rejected", "needs_info"]).optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
});

async function getReturnsHistoryStep(input: z.infer<typeof getReturnsHistoryInput>) {
  "use step";
  if (badDate(input.from, input.to)) {
    return { status: "invalid_input" as const, summary: INVALID_DATE_SUMMARY, returns: [] };
  }
  try {
    const { data, meta } = await getBackOfficeReturns({
      from: input.from,
      to: input.to,
      status: input.status,
      decision: input.decision,
      limit: input.limit ?? 25,
    });
    const returns = data.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      status: r.status,
      decision: r.decision,
      reason: r.reason.slice(0, 200),
      refundAmount: r.refundAmount,
      refundFormatted:
        r.refundAmount === null ? null : formatPrice(r.refundAmount, REPORT_CURRENCY),
      createdAt: r.createdAt,
      processedAt: r.processedAt,
    }));
    return {
      status: returns.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `${returns.length} return(s) between ${meta.from} and ${meta.to}. Refunds shown in ${REPORT_CURRENCY}.`,
      window: { from: meta.from, to: meta.to },
      returns,
    };
  } catch (err) {
    return { ...failure(err), returns: [] };
  }
}

export const getReturnsHistory = tool({
  description:
    "List returns and their refund decisions and amounts. Refund amounts are integer cents; use refundFormatted when reporting. Read-only: this cannot approve or issue refunds.",
  inputSchema: getReturnsHistoryInput,
  execute: getReturnsHistoryStep,
});

// ---------------------------------------------------------------------------
// getInventoryStock (paginated)
// ---------------------------------------------------------------------------

const getInventoryStockInput = z.object({
  productIds: z
    .array(z.string().trim().min(1).max(100))
    .max(20)
    .optional()
    .describe("Restrict to these product ids."),
  lowStock: z.boolean().optional().describe("true = only low stock (1–5 units)."),
  inStock: z.boolean().optional().describe("true = only products with stock."),
  page: z.number().int().min(1).optional().describe("1-based page, default 1."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
});

async function getInventoryStockStep(input: z.infer<typeof getInventoryStockInput>) {
  "use step";
  try {
    const { data, meta } = await getBackOfficeStock({
      productIds: input.productIds,
      lowStock: input.lowStock,
      inStock: input.inStock,
      page: input.page ?? 1,
      limit: input.limit ?? 50,
    });
    const { pagination } = meta;
    const items = data.map((s) => ({
      productId: s.productId,
      name: s.product.name,
      category: s.product.category,
      units: s.stock,
      inStock: s.inStock,
      lowStock: s.lowStock,
    }));
    return {
      status: items.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `Page ${pagination.page} of ${pagination.totalPages} (${pagination.total} products in total).`,
      pagination: {
        page: pagination.page,
        totalPages: pagination.totalPages,
        total: pagination.total,
        hasNextPage: pagination.hasNextPage,
      },
      items,
    };
  } catch (err) {
    return { ...failure(err), pagination: null, items: [] };
  }
}

export const getInventoryStock = tool({
  description:
    "Read stock levels, one page at a time (default 50 per page). Use lowStock or inStock to filter. Check hasNextPage before assuming you have every product. Read-only: this cannot change stock.",
  inputSchema: getInventoryStockInput,
  execute: getInventoryStockStep,
});

// ---------------------------------------------------------------------------
// getSalesAnalytics
// ---------------------------------------------------------------------------

const getSalesAnalyticsInput = z.object({
  from: isoDate,
  to: isoDate,
  productId: z.string().trim().min(1).max(100).optional(),
});

async function getSalesAnalyticsStep(input: z.infer<typeof getSalesAnalyticsInput>) {
  "use step";
  if (badDate(input.from, input.to)) {
    return { status: "invalid_input" as const, summary: INVALID_DATE_SUMMARY, rows: [] };
  }
  try {
    const { data, meta } = await getBackOfficeSales({
      from: input.from,
      to: input.to,
      productId: input.productId,
    });
    const rows = [...data]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 20)
      .map((r) => ({
        productId: r.productId,
        name: r.product.name,
        category: r.product.category,
        unitsSold: r.unitsSold,
        ordersCount: r.ordersCount,
        revenue: r.revenue,
        revenueFormatted: formatPrice(r.revenue, r.currency),
      }));
    const { totals } = meta;
    return {
      status: data.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `Sales from ${meta.from} to ${meta.to} (${meta.days} day(s)), in ${meta.currency}.`,
      window: { from: meta.from, to: meta.to, days: meta.days, currency: meta.currency },
      totals: {
        unitsSold: totals.unitsSold,
        ordersCount: totals.ordersCount,
        revenue: totals.revenue,
        revenueFormatted: formatPrice(totals.revenue, meta.currency),
      },
      rows,
    };
  } catch (err) {
    return { ...failure(err), totals: null, rows: [] };
  }
}

export const getSalesAnalytics = tool({
  description:
    "Sales totals and the top products by revenue for a date window. Revenue is integer cents; use revenueFormatted. State the window and currency in your answer. Read-only.",
  inputSchema: getSalesAnalyticsInput,
  execute: getSalesAnalyticsStep,
});

// ---------------------------------------------------------------------------
// searchCatalog and getCategories
// ---------------------------------------------------------------------------

const searchCatalogInput = z.object({
  query: z.string().trim().max(100).optional(),
  category: z.string().trim().min(1).max(40).optional().describe("Slug from getCategories."),
  limit: z.number().int().min(1).max(20).optional().describe("Default 10."),
});

async function searchCatalogStep(input: z.infer<typeof searchCatalogInput>) {
  "use step";
  const query = input.query?.trim() ?? "";
  if (!query && !input.category) {
    return {
      status: "invalid_input" as const,
      summary: "Provide a search term, a category, or both.",
      products: [],
    };
  }
  try {
    const products = await getProducts({
      search: query || undefined,
      category: input.category,
      limit: input.limit ?? 10,
    });
    return {
      status: products.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `${products.length} product(s) found.`,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        price: p.price,
        priceFormatted: formatPrice(p.price, p.currency),
      })),
    };
  } catch (err) {
    return { ...failure(err), products: [] };
  }
}

export const searchCatalog = tool({
  description: "Search the live product catalogue by text and/or category slug.",
  inputSchema: searchCatalogInput,
  execute: searchCatalogStep,
});

const getCategoriesInput = z.object({});

async function getCategoriesStep() {
  "use step";
  try {
    const categories = await getCategories();
    return {
      status: categories.length > 0 ? ("ok" as const) : ("no_results" as const),
      summary: `${categories.length} categor(y/ies) in the live catalogue.`,
      categories: categories.map((c) => ({
        slug: c.slug,
        name: c.name,
        productCount: c.productCount,
      })),
    };
  } catch (err) {
    return { ...failure(err), categories: [] };
  }
}

export const getCategoriesTool = tool({
  description: "List every product category in the live catalogue, with slugs and product counts.",
  inputSchema: getCategoriesInput,
  execute: getCategoriesStep,
});

// ---------------------------------------------------------------------------
// loadBackOfficeData: snapshots for bash joins
// ---------------------------------------------------------------------------

const loadBackOfficeDataInput = z.object({
  from: isoDate,
  to: isoDate,
});

async function loadBackOfficeDataStep(input: z.infer<typeof loadBackOfficeDataInput>) {
  "use step";
  if (badDate(input.from, input.to)) {
    return { status: "invalid_input" as const, summary: INVALID_DATE_SUMMARY, files: [] };
  }
  try {
    const range = { from: input.from, to: input.to };
    const [returns, tickets, sales] = await Promise.all([
      getBackOfficeReturns({ ...range, limit: 500 }),
      getBackOfficeSupportTickets({ ...range, limit: 500 }),
      getBackOfficeSales(range),
    ]);

    // Stock is paginated. Fetch up to 10 pages of 200 so the snapshot is bounded.
    const stock: unknown[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await getBackOfficeStock({ page, limit: 200 });
      stock.push(...res.data);
      if (!res.meta.pagination.hasNextPage) break;
    }

    const files = {
      "returns.json": returns.data,
      "support-tickets.json": tickets.data,
      "sales.json": sales.data,
      "stock.json": stock,
    };
    await writeAdminSnapshots(files);
    return {
      status: "ok" as const,
      summary: `Snapshots written for bash: ${returns.data.length} returns, ${tickets.data.length} tickets, ${sales.data.length} sales rows, ${stock.length} stock rows. Sales window ${sales.meta.from} to ${sales.meta.to}.`,
      files: Object.keys(files).map((name) => `/vercel/sandbox/data/${name}`),
    };
  } catch (err) {
    return { ...failure(err), files: [] };
  }
}

export const loadBackOfficeData = tool({
  description:
    "Refresh JSON snapshots of returns, support tickets, sales and stock in the admin sandbox at /vercel/sandbox/data/. Call this before bash when you need to join or aggregate. Defaults to the API's 30-day window.",
  inputSchema: loadBackOfficeDataInput,
  execute: loadBackOfficeDataStep,
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const bashInput = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      "Shell command run with bash in the admin sandbox. Read the snapshots in /vercel/sandbox/data (JSON arrays) with node for aggregates and joins.",
    ),
});

async function bashStep(input: z.infer<typeof bashInput>) {
  "use step";
  const result = await runAdminBash(input.command);
  const failed = result.exitCode !== 0;
  return {
    status: failed ? ("failed" as const) : ("ok" as const),
    summary: failed
      ? result.timedOut
        ? "The command timed out."
        : `The command exited with code ${result.exitCode ?? "unknown"}.`
      : "The command finished.",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export const bash = tool({
  description:
    "Run a bash command in the isolated admin sandbox, for aggregates and joins over the snapshots in /vercel/sandbox/data. Use node -e for JSON work (python is not installed). Do not try to reach the store API from here, and only read files, never write to them.",
  inputSchema: bashInput,
  execute: bashStep,
});

// ---------------------------------------------------------------------------
// appendMemory
// ---------------------------------------------------------------------------

const appendMemoryInput = z.object({
  note: z
    .string()
    .trim()
    .min(5)
    .max(400)
    .describe(
      "One durable fact or preference for future admin sessions. No customer personal data, no secrets.",
    ),
});

async function appendMemoryStep(input: z.infer<typeof appendMemoryInput>) {
  "use step";
  const note = redact(input.note);
  // Customer contact details are not kept in memory.
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(note)) {
    return {
      status: "rejected" as const,
      summary: "Notes must not contain email addresses. Store facts without customer details.",
    };
  }
  const { savedAt } = await appendAdminMemory(note);
  return { status: "saved" as const, summary: "Saved to admin memory.", savedAt };
}

export const appendMemory = tool({
  description:
    "Save one durable note to the admin memory file, which is shown to you at the start of future admin conversations. Use it only when staff ask you to remember something or for stable facts about how the back office works. Never store customer personal data or secrets.",
  inputSchema: appendMemoryInput,
  execute: appendMemoryStep,
});

export const adminTools = {
  getSupportTickets,
  getReturnsHistory,
  getInventoryStock,
  getSalesAnalytics,
  searchCatalog,
  getCategories: getCategoriesTool,
  loadBackOfficeData,
  bash,
  appendMemory,
};
