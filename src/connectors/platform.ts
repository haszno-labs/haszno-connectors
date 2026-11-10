/**
 * ShopPlatform adapter interface.
 *
 * Every platform (Shoprenter, UNAS, WooCommerce, Shopify, Medusa, …) implements this interface.
 * The mock adapter is the default; real HTTP adapters only activate
 * when their env credentials are present (never set in tests).
 *
 * Legal note: listProducts returns RESELLER prices from the shop,
 * never from other shops. updatePriceStock / pushProduct write only to the same shop.
 */

import type { FetchFn } from '../net/fetcher.js'
import { safeFetch } from '../net/safe-fetch.js'
import { UnasAdapterStub } from './adapters/unas.js'
import { WooCommerceAdapter } from './adapters/woocommerce.js'
import { ShopifyAdapter } from './adapters/shopify.js'
import { MedusaAdapter } from './adapters/medusa.js'

export interface ProductItem {
  externalId: string
  sku: string
  name: string
  /** Gross price in HUF. */
  priceGross: number
  stock: number
}

export interface OrderItem {
  externalId: string
  status: string
  customerName: string
  items: { sku: string; qty: number; priceGross: number }[]
  createdAt: string
}

/** Result of a testConnection call. */
export interface TestConnectionResult {
  ok: boolean
  mode: 'live' | 'mock'
  productCount?: number
  error?: string
}

export interface ShopPlatform {
  /**
   * Test whether the adapter can reach the shop and authenticate.
   * Returns { ok: true, mode, productCount } on success; { ok: false, error } on failure.
   * Must never throw — wrap internal errors and return ok: false.
   */
  testConnection(): Promise<TestConnectionResult>

  /**
   * List all products from the shop.
   * Mock adapter returns deterministic data.
   */
  listProducts(): Promise<ProductItem[]>

  /**
   * Push a product to the shop (create or update by SKU).
   * Returns the platform's external product ID.
   */
  pushProduct(p: ProductItem): Promise<{ externalId: string }>

  /**
   * Update the gross price and stock level of a product by its external ID.
   * Mock adapter is a no-op.
   */
  updatePriceStock(externalId: string, priceGross: number, stock: number): Promise<void>

  /**
   * Fetch orders created at or after `since`.
   * Mock adapter returns deterministic data.
   */
  fetchOrders(since: Date): Promise<OrderItem[]>

  /**
   * List recent orders (last 50). Legacy method kept for backward compatibility.
   * Prefer fetchOrders(since) for new code.
   */
  listOrders(): Promise<OrderItem[]>
}

// ---- Mock adapter (deterministic, default) ----

/** Deterministic mock data — same output on every call, no I/O. */
export class MockAdapter implements ShopPlatform {
  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, mode: 'mock', productCount: 3 }
  }

  async listProducts(): Promise<ProductItem[]> {
    return [
      { externalId: 'mock-1', sku: 'MOCK-SKU-001', name: 'Teszt termék 1', priceGross: 12700, stock: 15 },
      { externalId: 'mock-2', sku: 'MOCK-SKU-002', name: 'Teszt termék 2', priceGross: 25400, stock: 3 },
      { externalId: 'mock-3', sku: 'MOCK-SKU-003', name: 'Teszt termék 3', priceGross: 7900, stock: 0 },
    ]
  }

  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    return { externalId: p.externalId || `mock-pushed-${p.sku}` }
  }

  async updatePriceStock(_externalId: string, _priceGross: number, _stock: number): Promise<void> {
    // no-op in mock mode
  }

  async fetchOrders(since: Date): Promise<OrderItem[]> {
    const all = await this.listOrders()
    return all.filter((o) => new Date(o.createdAt) >= since)
  }

  async listOrders(): Promise<OrderItem[]> {
    return [
      {
        externalId: 'mock-order-1',
        status: 'processing',
        customerName: 'Teszt Ügyfél',
        items: [{ sku: 'MOCK-SKU-001', qty: 2, priceGross: 12700 }],
        createdAt: '2026-11-01T10:00:00Z',
      },
    ]
  }
}

// ---- Shoprenter adapter ----
//
// Shoprenter REST API: https://doc.shoprenter.hu/api/
// Authentication: HTTP Basic Auth (API username + API key).
// Base URL: https://{shopName}.api.myshoprenter.hu
//
// shopName: the shop's subdomain (e.g. "mybolt" → mybolt.api.myshoprenter.hu).
//   Provided via config.shopName; falls back to credentials.apiUser since
//   Shoprenter's API username IS the shop subdomain.
//
// Falls back to mock adapter if credentials are missing or shopName is invalid.

/** Page size for Shoprenter product listing. */
const SR_PAGE_SIZE = 100

/**
 * Retry a fetch operation up to `maxAttempts` on HTTP 429 (rate-limit) errors,
 * backing off exponentially. Any other error is rethrown immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = (err as Error).message
      if (attempt >= maxAttempts || !msg.includes('(429)')) throw err
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000)
      await new Promise<void>((r) => setTimeout(r, delay))
    }
  }
}

export class ShoprenterAdapter implements ShopPlatform {
  private readonly baseUrl: string
  private readonly auth: string
  private readonly doFetch: FetchFn

  /**
   * @param shopName  Shop subdomain (e.g. "mybolt" → mybolt.api.myshoprenter.hu).
   * @param apiUser   Shoprenter API username.
   * @param apiKey    Shoprenter API key.
   * @param fetchFn   Injectable fetch (defaults to safeFetch). Pass a mock in tests.
   */
  constructor(shopName: string, apiUser: string, apiKey: string, fetchFn?: FetchFn) {
    // https://doc.shoprenter.hu/api/
    this.baseUrl = `https://${shopName}.api.myshoprenter.hu`
    this.auth = Buffer.from(`${apiUser}:${apiKey}`).toString('base64')
    this.doFetch = fetchFn ?? safeFetch
  }

  private async apiCall<T>(path: string, init?: RequestInit): Promise<T> {
    return withRetry(async () => {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init?.headers as Record<string, string> | undefined),
        },
      })
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Shoprenter API hiba (${res.status}): ${errText}`)
      }
      return res.json() as Promise<T>
    })
  }

  async listProducts(): Promise<ProductItem[]> {
    // GET /api/products?full=1&page={n}&limit={size} — paginated
    // https://doc.shoprenter.hu/api/products.html
    // Shoprenter returns net prices; multiply by 1.27 (27% VAT) to get gross HUF.
    type SRProduct = { id: string; sku: string; price: string; stock: string }
    type SRList = { items: SRProduct[] }

    const all: ProductItem[] = []
    let page = 1

    while (true) {
      const data = await this.apiCall<SRList>(`/api/products?full=1&page=${page}&limit=${SR_PAGE_SIZE}`)
      const items = data.items ?? []

      for (const p of items) {
        all.push({
          externalId: p.id,
          sku: p.sku,
          name: p.sku, // name requires a separate /api/productDescriptions call; sku is used as fallback
          priceGross: Math.round(parseFloat(p.price) * 1.27), // net → gross (27% VAT)
          stock: parseInt(p.stock, 10) || 0,
        })
      }

      if (items.length < SR_PAGE_SIZE) break
      page++
    }

    return all
  }

  async updatePriceStock(sku: string, priceGross: number, stock: number): Promise<void> {
    // Find product by SKU first, then PUT /api/products/{id}
    // https://doc.shoprenter.hu/api/products.html
    type SRList = { items: { id: string; sku: string }[] }
    const data = await this.apiCall<SRList>(`/api/products?sku=${encodeURIComponent(sku)}`)
    if (!data.items.length) throw new Error(`SKU nem található a Shoprenterben: ${sku}`)
    const id = data.items[0].id
    const netPrice = (priceGross / 1.27).toFixed(4) // convert gross HUF back to net
    await this.apiCall(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ price: netPrice, stock: String(stock) }),
    })
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const products = await this.listProducts()
      return { ok: true, mode: 'live', productCount: products.length }
    } catch (err) {
      return { ok: false, mode: 'live', error: (err as Error).message }
    }
  }

  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    // 1. Search for existing product by SKU
    // https://doc.shoprenter.hu/api/products.html
    type SRList = { items: { id: string; sku: string }[] }
    const existing = await this.apiCall<SRList>(`/api/products?sku=${encodeURIComponent(p.sku)}`)
    const netPrice = (p.priceGross / 1.27).toFixed(4) // gross HUF → net

    if (existing.items.length > 0) {
      // 2a. Product found — update price and stock only (idempotent)
      const id = existing.items[0].id
      await this.apiCall(`/api/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ price: netPrice, stock: String(p.stock) }),
      })
      return { externalId: id }
    }

    // 2b. Product not found — create with sku, price, stock
    type SRCreateResponse = { id: string }
    const created = await this.apiCall<SRCreateResponse>('/api/products', {
      method: 'POST',
      body: JSON.stringify({ sku: p.sku, price: netPrice, stock: String(p.stock) }),
    })
    return { externalId: created.id }
  }

  async fetchOrders(since: Date): Promise<OrderItem[]> {
    // Filter is not directly supported by Shoprenter API; list all and filter client-side.
    const all = await this.listOrders()
    return all.filter((o) => new Date(o.createdAt) >= since)
  }

  async listOrders(): Promise<OrderItem[]> {
    // GET /api/orders?limit=50 — returns paginated orders
    // https://doc.shoprenter.hu/api/orders.html
    type SROrder = { id: string; status: string; customer: { firstname: string; lastname: string }; dateCreated: string; orderProducts: { sku: string; quantity: string; grossPrice: string }[] }
    type SRList = { items: SROrder[] }
    const data = await this.apiCall<SRList>('/api/orders?limit=50')
    return data.items.map((o) => ({
      externalId: o.id,
      status: o.status,
      customerName: `${o.customer.firstname} ${o.customer.lastname}`,
      items: (o.orderProducts ?? []).map((p) => ({
        sku: p.sku,
        qty: parseInt(p.quantity, 10) || 1,
        priceGross: Math.round(parseFloat(p.grossPrice)),
      })),
      createdAt: o.dateCreated,
    }))
  }
}

// ---- Adapter factory ----

/** Shop subdomain label (e.g. "mybolt" in mybolt.api.myshoprenter.hu) — never a host, path or URL. */
export function isValidShopName(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
}

/**
 * Returns the correct ShopPlatform adapter for a given connection.
 *
 * @param platform  Platform slug: 'shoprenter' | 'unas' | 'woocommerce' | 'shopify' | 'medusa' | 'mock'
 * @param config    Non-sensitive platform config (from shop_connections.config).
 * @param credentials  Decrypted credentials map.
 *                     For Shoprenter/UNAS falls back to env vars when credentials are empty.
 *
 * Always falls back to MockAdapter when credentials are absent (safe default for tests/dev).
 */
export function createAdapter(
  platform: string,
  config: Record<string, unknown>,
  credentials: Record<string, string> = {},
): ShopPlatform {
  if (platform === 'shoprenter') {
    // shopName is the shop's subdomain (e.g. "mybolt" → mybolt.api.myshoprenter.hu).
    // config.shopName is the canonical source; falls back to credentials.apiUser since
    // Shoprenter's API username IS the shop subdomain.
    const shopName = (config.shopName as string | undefined) ?? credentials.apiUser ?? process.env['SHOPRENTER_SHOP_NAME'] ?? ''
    // Accept explicit credentials OR legacy env vars (backward compat)
    const apiUser = credentials.apiUser ?? process.env['SHOPRENTER_API_USER']
    const apiKey = credentials.apiKey ?? process.env['SHOPRENTER_API_KEY']
    if (apiUser && apiKey && isValidShopName(shopName)) {
      return new ShoprenterAdapter(shopName, apiUser, apiKey)
    }
    return new MockAdapter()
  }

  if (platform === 'unas') {
    const apiKey = credentials.apiKey ?? process.env['UNAS_API_KEY']
    if (apiKey) {
      return new UnasAdapterStub(config, { apiKey })
    }
    return new MockAdapter()
  }

  if (platform === 'woocommerce') {
    return new WooCommerceAdapter(config, credentials)
  }

  if (platform === 'shopify') {
    return new ShopifyAdapter(config, credentials)
  }

  if (platform === 'medusa') {
    return new MedusaAdapter(config, credentials)
  }

  return new MockAdapter()
}
