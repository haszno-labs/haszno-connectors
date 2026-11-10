/**
 * Shopify Admin REST API adapter.
 *
 * API version: 2024-01 (stable REST Admin API)
 * Docs: https://shopify.dev/docs/api/admin-rest/2024-01
 *
 * Authentication: X-Shopify-Access-Token header (Custom App or private app access token)
 * credentials keys: { accessToken } — Shopify Admin API access token
 * config keys: { shopDomain } — full myshopify.com domain, e.g. "mystore.myshopify.com"
 *
 * API choice: REST over GraphQL
 *   REST was chosen because:
 *   - Simpler request/response shapes for straightforward CRUD
 *   - `since_id` cursor pagination works without header access (safeFetch wraps responses
 *     without exposing Link headers, which cursor-based REST pagination requires)
 *   - All required operations (products, variants, inventory, orders) are well-covered
 *   GraphQL Admin API is preferred for bulk mutations and complex nested queries,
 *   but adds schema complexity for this use case.
 *
 * externalId mapping:
 *   Each ProductItem maps to the FIRST VARIANT of a Shopify product.
 *   externalId = Shopify variant ID (string). This gives direct access to the
 *   specific variant for price and inventory updates.
 *
 * Price handling:
 *   Shopify stores prices as decimal strings in the shop's currency (e.g. "12700.00").
 *   We assume the shop currency is HUF and treat the price as gross.
 *   HUF has no fractional subunit so Math.round is safe.
 *
 * Inventory:
 *   Shopify's inventory_quantity on a variant is read-only via GET.
 *   Updates require POST /inventory_levels/set.json at a specific location.
 *   We use the shop's first active location (GET /locations.json).
 *
 * SSRF guard:
 *   The shopDomain must end with ".myshopify.com" (allowlisted suffix) and pass
 *   isValidPublicHostname. All HTTP calls go through safeFetch (injectable for tests).
 */

import type { FetchFn } from '../../net/fetcher.js'
import { isValidPublicHostname, safeFetch } from '../../net/safe-fetch.js'
import type { OrderItem, ProductItem, ShopPlatform, TestConnectionResult } from '../platform.js'

// ── Shopify REST response shapes ─────────────────────────────────────────────

interface ShopifyVariant {
  id: number
  sku: string | null
  price: string              // decimal string, e.g. "12700.00"
  inventory_quantity: number
  inventory_item_id: number
  inventory_management: string | null
}

interface ShopifyProduct {
  id: number
  title: string
  status: string
  variants: ShopifyVariant[]
}

interface ShopifyLineItem {
  sku: string | null
  quantity: number
  price: string
}

interface ShopifyOrder {
  id: number
  financial_status: string
  fulfillment_status: string | null
  customer: { first_name?: string; last_name?: string; email?: string } | null
  line_items: ShopifyLineItem[]
  created_at: string
}

interface ShopifyLocation {
  id: number
  name: string
  active: boolean
}

// ── Domain validation ────────────────────────────────────────────────────────

const MYSHOPIFY_SUFFIX = '.myshopify.com'

/**
 * Validate that `domain` is a well-formed public *.myshopify.com hostname.
 * Returns null on success, or an error string.
 */
function validateShopifyDomain(domain: string): string | null {
  if (!domain) return 'Hiányzó shopDomain a konfigurációban'
  if (!domain.endsWith(MYSHOPIFY_SUFFIX)) {
    return `A bolt domainja .myshopify.com végzetű kell legyen (kapott: ${domain})`
  }
  if (!isValidPublicHostname(domain)) {
    return `Érvénytelen hoszt: ${domain}`
  }
  return null
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class ShopifyAdapter implements ShopPlatform {
  private readonly baseUrl: string
  private readonly accessToken: string
  private readonly fetchFn: FetchFn
  private readonly domainError: string | null

  /**
   * @param config      Non-sensitive config from shop_connections.config — expects { shopDomain }
   * @param credentials Decrypted credentials — expects { accessToken }
   * @param fetchFn     Optional fetch override for testing (defaults to safeFetch)
   */
  constructor(
    config: Record<string, unknown>,
    credentials: Record<string, string>,
    fetchFn?: FetchFn,
  ) {
    this.fetchFn = fetchFn ?? safeFetch
    // Never store accessToken in a property that is enumerable/logged — assign directly
    this.accessToken = credentials.accessToken ?? ''

    const rawDomain = (config.shopDomain as string | undefined) ?? ''
    this.domainError = validateShopifyDomain(rawDomain)
    this.baseUrl = this.domainError ? '' : `https://${rawDomain}/admin/api/2024-01`
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Authenticated GET/POST/PUT against the Shopify Admin REST API. */
  private async apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...((init?.headers ?? {}) as Record<string, string>),
      },
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Shopify API hiba (${res.status}): ${errText.substring(0, 200)}`)
    }
    return res.json() as Promise<T>
  }

  /**
   * Paginate through ALL products using since_id.
   * safeFetch does not expose the Link response header, so we use since_id pagination
   * instead of cursor-based pagination (which requires Link header parsing).
   */
  private async fetchAllProducts(): Promise<ShopifyProduct[]> {
    const all: ShopifyProduct[] = []
    let sinceId = 0

    for (;;) {
      const qs = sinceId ? `since_id=${sinceId}&limit=250&status=active` : 'limit=250&status=active'
      const data = await this.apiFetch<{ products: ShopifyProduct[] }>(`/products.json?${qs}`)
      const chunk = data.products ?? []
      all.push(...chunk)
      if (chunk.length < 250) break
      sinceId = chunk[chunk.length - 1].id
    }

    return all
  }

  /** Fetch the ID of the shop's first active location (required for inventory updates). */
  private async getPrimaryLocationId(): Promise<number> {
    const data = await this.apiFetch<{ locations: ShopifyLocation[] }>('/locations.json?active=true&limit=1')
    const locs = data.locations ?? []
    if (!locs.length) throw new Error('Shopify: nincs aktív helyszín az árukészlet frissítéséhez')
    return locs[0].id
  }

  // ── ShopPlatform interface ─────────────────────────────────────────────────

  /**
   * Test connection by calling GET /shop.json (lightweight shop info endpoint).
   * Never throws — wraps all errors and returns ok: false.
   */
  async testConnection(): Promise<TestConnectionResult> {
    if (this.domainError) return { ok: false, mode: 'live', error: this.domainError }
    if (!this.accessToken) return { ok: false, mode: 'live', error: 'Hiányzó Shopify access token' }
    try {
      await this.apiFetch<{ shop: { id: number } }>('/shop.json')
      const products = await this.fetchAllProducts()
      return { ok: true, mode: 'live', productCount: products.length }
    } catch (err) {
      return { ok: false, mode: 'live', error: (err as Error).message }
    }
  }

  /**
   * List all active products from the Shopify store.
   * Returns one ProductItem per product, mapped from the product's first variant.
   * externalId = Shopify variant ID.
   */
  async listProducts(): Promise<ProductItem[]> {
    const shopifyProducts = await this.fetchAllProducts()
    const result: ProductItem[] = []

    for (const p of shopifyProducts) {
      if (!p.variants?.length) continue
      const v = p.variants[0]  // first variant represents the product
      result.push({
        externalId: String(v.id),
        sku: v.sku ?? `shopify-variant-${v.id}`,
        name: p.title,
        priceGross: Math.round(parseFloat(v.price) || 0),
        stock: v.inventory_quantity ?? 0,
      })
    }

    return result
  }

  /**
   * Push a product to the Shopify store: create new, or update existing by SKU.
   * Returns the Shopify variant ID as externalId.
   *
   * SKU lookup: scans all existing products client-side (Shopify REST has no server-side
   * SKU filter). For shops with up to a few thousand products this is acceptable.
   */
  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    // 1. Check if a variant with this SKU already exists
    const existing = await this.fetchAllProducts()
    for (const prod of existing) {
      for (const v of prod.variants ?? []) {
        if (v.sku === p.sku) {
          // Update existing variant
          await this.updatePriceStock(String(v.id), p.priceGross, p.stock)
          return { externalId: String(v.id) }
        }
      }
    }

    // 2. Create new product with one variant
    const body = {
      product: {
        title: p.name,
        status: 'active',
        variants: [
          {
            sku: p.sku,
            price: p.priceGross.toFixed(2),
            inventory_management: 'shopify',
            inventory_quantity: p.stock,
          },
        ],
      },
    }
    const data = await this.apiFetch<{ product: ShopifyProduct }>('/products.json', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const created = data.product
    if (!created.variants?.length) throw new Error('Shopify: a létrehozott terméknek nincs variánsa')
    return { externalId: String(created.variants[0].id) }
  }

  /**
   * Update the gross price and stock level of a product by its Shopify variant ID.
   *
   * Price: PUT /variants/{variantId}.json
   * Stock: POST /inventory_levels/set.json at the shop's primary location
   */
  async updatePriceStock(variantId: string, priceGross: number, stock: number): Promise<void> {
    // 1. Update price on the variant
    await this.apiFetch<{ variant: ShopifyVariant }>(`/variants/${variantId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ variant: { id: Number(variantId), price: priceGross.toFixed(2) } }),
    })

    // 2. Get inventory_item_id for the variant (returned by the GET below)
    const variantData = await this.apiFetch<{ variant: ShopifyVariant }>(`/variants/${variantId}.json`)
    const inventoryItemId = variantData.variant.inventory_item_id

    // 3. Set inventory level at the primary location
    const locationId = await this.getPrimaryLocationId()
    await this.apiFetch<unknown>('/inventory_levels/set.json', {
      method: 'POST',
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: stock,
      }),
    })
  }

  /**
   * Fetch orders created at or after `since`.
   * Uses Shopify's created_at_min filter (server-side — efficient).
   */
  async fetchOrders(since: Date): Promise<OrderItem[]> {
    const isoSince = since.toISOString()
    const data = await this.apiFetch<{ orders: ShopifyOrder[] }>(
      `/orders.json?status=any&created_at_min=${encodeURIComponent(isoSince)}&limit=250`,
    )
    return (data.orders ?? []).map(mapOrder)
  }

  /**
   * List recent orders (last 50). Legacy method kept for backward compatibility.
   * Prefer fetchOrders(since) for new code.
   */
  async listOrders(): Promise<OrderItem[]> {
    const data = await this.apiFetch<{ orders: ShopifyOrder[] }>('/orders.json?status=any&limit=50')
    return (data.orders ?? []).map(mapOrder)
  }
}

// ── Mapping helpers ───────────────────────────────────────────────────────────

function mapOrder(o: ShopifyOrder): OrderItem {
  const firstName = o.customer?.first_name ?? ''
  const lastName = o.customer?.last_name ?? ''
  const customerName = [firstName, lastName].filter(Boolean).join(' ') || o.customer?.email || 'Ismeretlen'

  return {
    externalId: String(o.id),
    status: o.fulfillment_status ?? o.financial_status ?? 'unknown',
    customerName,
    items: (o.line_items ?? []).map((li) => ({
      sku: li.sku ?? '',
      qty: li.quantity,
      priceGross: Math.round(parseFloat(li.price) || 0),
    })),
    createdAt: o.created_at,
  }
}
