/**
 * @haszno/connectors — public API
 *
 * Shop platform adapters (WooCommerce, Shopify, UNAS, Shoprenter, Medusa),
 * supplier feed parsers, and product feed exporters for the Haszno dropshipping network.
 */

// ── Platform interface & factory ──────────────────────────────────────────────
export type {
  ShopPlatform,
  ProductItem,
  OrderItem,
  TestConnectionResult,
} from './connectors/platform.js'
export {
  MockAdapter,
  ShoprenterAdapter,
  createAdapter,
  isValidShopName,
} from './connectors/platform.js'

// ── Platform adapters ─────────────────────────────────────────────────────────
export { WooCommerceAdapter } from './connectors/adapters/woocommerce.js'
export { ShopifyAdapter } from './connectors/adapters/shopify.js'
export { UnasAdapterStub } from './connectors/adapters/unas.js'
export { MedusaAdapter } from './connectors/adapters/medusa.js'

// ── Feed parsers ──────────────────────────────────────────────────────────────
export type { FeedProduct, MarketPrice } from './feeds/parse.js'
export { parseSupplierFeed, parseMarketPrices, parseCsv } from './feeds/parse.js'

// ── Feed exporters ────────────────────────────────────────────────────────────
export type { ExportProduct } from './feeds/export.js'
export { arukeresoXml, googleXml } from './feeds/export.js'

// ── SSRF guard (re-exported for callers that inject a custom fetch) ────────────
export type { FetchFn } from './net/fetcher.js'
export {
  safeFetch,
  makeSafeFetch,
  isValidPublicHostname,
  isPrivateAddress,
  readBodyCapped,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
} from './net/safe-fetch.js'
