/**
 * Tools for the shopping agent.
 *
 * Every tool's `execute` is a `"use step"` function, so each external call
 * (store API, return workflow) is its own durable step: it is retried on
 * transient failures and is never re-run once it has completed.
 *
 * Results are plain, serialisable objects. They never include the store API
 * bypass secret or raw upstream error bodies. Missing records and rejected
 * requests come back as structured statuses the model can explain, instead of
 * being turned into invented success.
 */
import { tool } from "ai";
import { z } from "zod";
import { start } from "workflow/api";
import {
  getCategories,
  getOrder,
  getProductById,
  getProductStock,
  getProducts,
} from "@/lib/api";
import { clientFailure } from "@/lib/tool-errors";
import { returnFlow } from "@/lib/workflows/return-flow";
import type { Order, Product, StockInfo } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  category: string;
  /** Integer cents. Format with `formatPrice` before showing. */
  price: number;
  currency: string;
  image: string | null;
}

export interface ProductDetail extends ProductSummary {
  description: string;
  tags: string[];
  images: string[];
}

function toSummary(p: Product): ProductSummary {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    category: p.category,
    price: p.price,
    currency: p.currency,
    image: p.images[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// searchProducts
// ---------------------------------------------------------------------------

const searchProductsInput = z.object({
  query: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Free-text search, e.g. 'hoodie' or 'water bottle'."),
  category: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("Category slug from getAllCategories, e.g. 'hats'."),
  limit: z.number().int().min(1).max(12).optional().describe("Max results, default 8."),
});

async function searchProductsStep(input: z.infer<typeof searchProductsInput>) {
  "use step";
  const query = input.query?.trim() ?? "";
  if (!query && !input.category) {
    return {
      status: "invalid_input" as const,
      message: "Provide a search term, a category, or both.",
      products: [] as ProductSummary[],
    };
  }
  try {
    const products = await getProducts({
      search: query || undefined,
      category: input.category,
      limit: input.limit ?? 8,
    });
    if (products.length === 0) {
      return {
        status: "no_results" as const,
        message: "No products matched that search.",
        products: [] as ProductSummary[],
      };
    }
    return {
      status: "ok" as const,
      message: `Found ${products.length} product(s).`,
      products: products.map(toSummary),
    };
  } catch (err) {
    return { ...clientFailure(err), products: [] as ProductSummary[] };
  }
}

export const searchProducts = tool({
  description:
    "Search the store catalogue by text and/or category. Returns product summaries with prices in integer cents.",
  inputSchema: searchProductsInput,
  execute: searchProductsStep,
});

// ---------------------------------------------------------------------------
// getAllCategories
// ---------------------------------------------------------------------------

const getAllCategoriesInput = z.object({});

async function getAllCategoriesStep() {
  "use step";
  const categories = await getCategories();
  return {
    status: categories.length > 0 ? ("ok" as const) : ("no_results" as const),
    categories: categories.map((c) => ({
      slug: c.slug,
      name: c.name,
      productCount: c.productCount,
    })),
  };
}

export const getAllCategories = tool({
  description:
    "List every product category currently in the live store catalogue. Use the slugs with searchProducts.",
  inputSchema: getAllCategoriesInput,
  execute: getAllCategoriesStep,
});

// ---------------------------------------------------------------------------
// getProductDetails
// ---------------------------------------------------------------------------

const getProductDetailsInput = z.object({
  productId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Product id or slug, as returned by searchProducts."),
});

async function getProductDetailsStep(input: z.infer<typeof getProductDetailsInput>) {
  "use step";
  let product: Product;
  try {
    product = await getProductById(input.productId);
  } catch (err) {
    return { ...clientFailure(err), product: null, stock: null };
  }

  // Stock is secondary. If it fails, return the product with stock unknown
  // rather than failing the whole lookup.
  let stock: StockInfo | null = null;
  let stockMessage: string | null = null;
  try {
    stock = await getProductStock(product.id);
  } catch (err) {
    // Only 4xx responses count as "no stock info". 5xx and network errors
    // are rethrown by clientFailure and retried by the step.
    const failure = clientFailure(err);
    stockMessage = failure.message;
  }

  const detail: ProductDetail = {
    ...toSummary(product),
    description: product.description,
    tags: product.tags,
    images: product.images,
  };
  return {
    status: "ok" as const,
    product: detail,
    stock: stock
      ? { inStock: stock.inStock, lowStock: stock.lowStock, units: stock.stock }
      : null,
    stockMessage,
  };
}

export const getProductDetails = tool({
  description:
    "Get one product's full details: description, price, images, tags and live stock. The store has no size or colour variant options, so do not claim any.",
  inputSchema: getProductDetailsInput,
  execute: getProductDetailsStep,
});

// ---------------------------------------------------------------------------
// returnOrder
// ---------------------------------------------------------------------------

const RETURNABLE_STATUSES: Order["status"][] = ["paid", "shipped", "delivered"];

const returnOrderInput = z.object({
  orderId: z.string().trim().min(1).max(100).describe("The order id from the customer's receipt."),
  reason: z
    .string()
    .trim()
    .min(5)
    .max(500)
    .describe("Why the customer wants to return the order, in their words."),
});

/**
 * Looks up the order, checks it can be returned, then starts the return
 * workflow and returns immediately. The workflow runs notify, refund
 * pre-authorisation and return filing as separate durable steps, so the chat
 * does not wait for them.
 */
async function returnOrderStep(input: z.infer<typeof returnOrderInput>) {
  "use step";
  let order: Order;
  try {
    order = await getOrder(input.orderId);
  } catch (err) {
    return { ...clientFailure(err), runId: null };
  }

  if (!RETURNABLE_STATUSES.includes(order.status)) {
    return {
      status: "not_eligible" as const,
      message: `Order ${order.id} is "${order.status}" and cannot be returned.`,
      runId: null,
    };
  }

  // Each return-flow step is separately durable and is skipped on retry once
  // it has completed, so retrying this outer step cannot repeat a notification
  // or refund pre-authorisation.
  const run = await start(returnFlow, [
    {
      orderId: order.id,
      reason: input.reason,
      items: order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    },
  ]);

  return {
    status: "filed" as const,
    message:
      "The return has been started. The customer is being notified, the refund is being pre-authorised, and the return is being filed.",
    orderId: order.id,
    runId: run.runId,
  };
}

export const returnOrder = tool({
  description:
    "Start a return for an order. Looks the order up, notifies the customer, pre-authorises the refund and files the return in the background. Once it returns status 'filed', tell the shopper the return is filed. Do not claim the refund has been paid.",
  inputSchema: returnOrderInput,
  execute: returnOrderStep,
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const shoppingTools = {
  searchProducts,
  getAllCategories,
  getProductDetails,
  returnOrder,
};
