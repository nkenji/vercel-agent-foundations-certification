# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`).

- `pnpm dev` — start the Next.js dev server on http://localhost:3000
- `pnpm build` — production build
- `pnpm start` — serve the production build
- `pnpm lint` — wired but `eslint` is not installed; the script will fail until a linter is added

There is no test framework wired up.

## Stack

- **Next.js 16** App Router with **React 19**
- **TypeScript** with `strict: true`, `@/*` path alias maps to the project root
- **Tailwind CSS v4** (PostCSS plugin); theme tokens are CSS variables defined in `app/globals.css`
- **shadcn/ui** (new-york style, neutral base) — components live in `components/ui/`, generator config in `components.json`. Use `cn()` from `lib/utils.ts` for class merging
- **lucide-react** for icons

## Environment

`.env.local` (gitignored) holds:

- `BYPASS_SECRET` — required. Sent as the `x-vercel-protection-bypass` header on every API call. Must never be exposed to the client (no `NEXT_PUBLIC_` prefix).
- `API_BASE_URL` — optional. Defaults to `https://vercel-agentic-swag-store-api.vercel.app/api` in `lib/api.ts`.
- `VERCEL_OIDC_TOKEN` — written by `vercel env pull`. Lets the AI SDK reach Vercel AI Gateway locally.

`.env.example` is the redacted template for new developers. In Vercel, set `BYPASS_SECRET` as an environment variable on the project.

`ADMIN_PASSWORD` is not an env var yet: it is the literal in `lib/admin-auth.ts` (demo only).

## Architecture

The storefront brand is **Ship It Shop** (metadata, header, homepage copy). The store is backed by the live **Vercel Swag Store API** (no local product/cart database). The protection-bypass secret stays server-side: every API read happens in a Server Component or Server Action, every cart mutation goes through a Server Action, and the cart token cookie is `httpOnly`.

### Data layer (`lib/`)

- `lib/types.ts` — pure type module re-exporting the API schemas (`Product`, `CartWithProducts`, `CartItemWithProduct`, `Promotion`, `Category`, `StockInfo`, `StoreConfig`). Both server and client modules import from here. Also exports the `CATEGORY_SLUGS` const tuple used by the category filter.
- `lib/api.ts` — typed `fetch` wrapper. Functions: `getProducts`, `getProductById`, `getProductStock`, `getCategories`, `getPromotion`, `getStoreConfig`, `cartCreate`, `cartGet`, `cartAdd`, `cartUpdate`, `cartRemove`. **Server-only** by convention (reads `process.env.VERCEL_PROTECTION_BYPASS_SECRET`). Throws `ApiRequestError` on non-200/`success:false` responses.
- `lib/cart-token.ts` — `getOrCreateCartToken()`/`getCartToken()`/`clearCartToken()` using `next/headers`. Stores the API-issued cart UUID in an `httpOnly` cookie `cart_token` with a 30-day max-age.
- `lib/cart-actions.ts` — `'use server'` actions: `getCartAction`, `addToCartAction`, `updateCartItemAction`, `removeCartItemAction`, `getProductStockAction`. Each cart mutation calls the API and `revalidateTag('cart')`. The first add lazily creates the cart on the server.
- `lib/format.ts` — `formatPrice(cents, currency)` using `Intl.NumberFormat`. **API prices are integers in cents**, so always pass them through this helper.
- `lib/tool-errors.ts` — `clientFailure(err)`: maps 404 to `not_found`, other 4xx to `rejected`, and rethrows 5xx/network so the step retries.
- `lib/tools.ts` — shopping tools (`searchProducts`, `getAllCategories`, `getProductDetails`, `returnOrder`) exported as `shoppingTools`. Each `execute` is a `"use step"` function.
- `lib/admin-tools.ts` — admin tools exported as `adminTools`. Read-only back-office tools, `loadBackOfficeData`, `bash`, and `appendMemory`. Never given to the shopping agent.
- `lib/admin-sandbox.ts` — the named persistent Vercel Sandbox `ship-shop-admin` (`node24`). Holds the memory file and JSON snapshots. `redact()` strips the bypass secret and admin password from output.
- `lib/admin-guard.ts` — `isAdminRequest()` checks the admin cookie for API routes. `proxy.ts` only guards /admin pages.
- `lib/agent.ts` — `SHOPPING_MODEL`/`SHOPPING_INSTRUCTIONS` and `ADMIN_MODEL`/`buildAdminInstructions()`. Models are AI Gateway `provider/model` strings. Both currently use the free `nvidia/nemotron-3.5-lightning-free`, because the account has no paid credits. Free-tier models must be on the free list, or the gateway returns "Free tier users do not have access to this model".
- `lib/workflows/` — `return-flow.ts` (notify, pre-authorise refund, file return as separate steps), `chat-flow.ts` (shopping `WorkflowAgent`), `admin-chat-flow.ts` (admin `WorkflowAgent`).
- `components/cart-provider.tsx` — Client `CartProvider` that hydrates the cart on mount by calling `getCartAction()` (so the layout can stay synchronous and routes can be statically rendered). Mutations dispatch through Server Actions inside `startTransition`, with `useOptimistic` for snappy UI.

### Caching strategy

Classic App Router (Cache Components / `'use cache'` are intentionally **not** used).

- Read endpoints (`getProducts`, `getProductById`, `getCategories`, `getPromotion`, `getStoreConfig`) pass `next: { revalidate: 300, tags: [...] }` to `fetch`. Tags: `products`, `product:{id}`, `categories`, `promotion`, `store-config`.
- `getProductStock` uses `cache: 'no-store'` so the indicator reflects live inventory.
- All cart endpoints use `cache: 'no-store'`. Mutations call `revalidateTag('cart')`, primarily for navigation re-renders — same-page UI relies on the action's return value + `useOptimistic`.

### Routes (App Router)

- `/` (`app/page.tsx`) — **Static** (`○`). Synchronous parent component renders three siblings (`<PromoBanner />`, `<FeaturedProducts />`, `<CategoryShowcase />`) so async children fan out in parallel. Each handles its own data fetch.
- `/search` (`app/search/page.tsx`) — **Dynamic** (`ƒ`, by necessity — uses `searchParams`). Reads `q` and `category`, fetches categories + products in parallel via `Promise.all`, and renders results inline (no `Suspense`). Loading feedback is a spinner inside `<SearchForm />` driven by `useTransition`.
- `app/search/search-form.tsx` — Client. `next/form` `<Form>` for the no-JS fallback, debounced 300ms `router.replace` wrapped in `startTransition` once `q.length >= 3` (or back to empty), `<Select>` from shadcn for the category dropdown.
- `/products/[param]` (`app/products/[param]/page.tsx`) — **SSG** (`●`). The `param` accepts both product **id** and **slug** (the API resolves either). `generateStaticParams` enumerates products via `getProducts({ limit: 100 })`; `generateMetadata` builds title, description, and `openGraph`/`twitter` cards using `product.images`. The page renders product image, name, price, description server-side; the only client island is `<ProductPurchase />`.
- `app/products/[param]/product-purchase.tsx` — Client. Stock + qty selector + Add-to-Cart. Fetches stock on mount via `getProductStockAction`, polls every 30s. Initial render shows "Checking availability…" until the action resolves; this is the cost of keeping the product page statically renderable.
- `app/products/[param]/related-products.tsx` — Server, async. `getProducts({ category, limit: 8 })`, filters out the current product, slices to 4.

### Layout

`app/layout.tsx` is **synchronous** so it doesn't opt routes out of static rendering. It mounts `<Header />` (server) — which contains `<CartButton />` (client) — `<Footer />`, `<CartProvider>` (no initial cart prop; provider hydrates client-side), and `<CartSheet />`. `metadataBase`, `title.template`, and root `openGraph`/`twitter` defaults live here.

### Client / server split

Client components are kept minimal — only where state, effects, or browser APIs are required:
- `cart-provider.tsx`, `cart-button.tsx`, `cart-sheet.tsx` (cart state + UI)
- `app/products/[param]/product-purchase.tsx` (stock polling, qty, add-to-cart)
- `app/search/search-form.tsx` (input state + URL sync)

Everything else (`Header`, `Footer`, `ProductCard`, `ProductGrid`, `PromoBanner`, `CategoryShowcase`, `RelatedProducts`, every page) is a Server Component.

### Configuration quirks

- `next.config.mjs` keeps `typescript.ignoreBuildErrors: true` and `images.unoptimized: true`. `images.remotePatterns` is whitelisted for `**.public.blob.vercel-storage.com` and `**.vercel-storage.com` (where API product images live); add hostnames here if the API ever returns images from a new domain.
- Agents run on Vercel Workflows (`withWorkflow` in `next.config.mjs`). `@vercel/sandbox` must NOT be in `serverExternalPackages`, because the workflow compiler needs to bundle it.
- Chat reconnect: the client POSTs to `/api/chat` (or `/api/admin/chat`) and reads `x-workflow-run-id`. It reconnects through `[id]/stream` with `startIndex` counting UI chunks. The routes replay raw parts from 0 and skip what the client already has.
- `package.json` pins `ai` to 7.0.177 and `@ai-sdk/provider` to 4.0.39 through `overrides` in `pnpm-workspace.yaml` (pnpm 12 ignores the `pnpm` field in package.json). Node 22.19+ is required. `@ai-sdk/react` depends on a different `ai` version, so without the overrides TypeScript reports duplicate types.
- The admin cookie `admin_auth` is set with `path: "/"` so `/api/admin/*` receives it.
- `@vercel/analytics` only mounts when `NODE_ENV === 'production'` (see `app/layout.tsx`).
- The repo is linked to v0 (`https://v0.app/chat/projects/prj_X7UGePkFlLC33RuxWiTZySFDcSzO`); merges to `main` auto-deploy via Vercel. v0 may push commits directly. When deploying, set `VERCEL_PROTECTION_BYPASS_SECRET` in the Vercel project's environment variables.
- The root layout is intentionally synchronous so it doesn't opt routes out of static. `pnpm build` should report `/` as `○` (Static), `/products/[param]` as `●` (SSG), and `/search` as `ƒ` (Dynamic). If you ever convert the layout to `async function` and `await` something that uses `cookies()`/`headers()`/`searchParams`, you will silently switch every route back to dynamic — verify the build output after layout changes.
