/**
 * WooCommerce REST API v3 adapter.
 *
 * WooCommerce REST API v3: https://woocommerce.github.io/woocommerce-rest-api-docs/
 * Authentication: HTTP Basic Auth (consumer key as username, consumer secret as password)
 *   — works over HTTPS; safeFetch enforces HTTPS so this is safe.
 * Base URL: https://{domain}/wp-json/wc/v3
 *
 * credentials keys: { consumerKey, consumerSecret }
 * config keys:      { domain } — public shop domain, SSRF-validated via isValidPublicHostname
 *
 * Network calls are injectable via the optional fetchFn constructor parameter so
 * tests can mock them without touching the network or DNS.
 */

import type { FetchFn } from '../../net/fetcher.js'
import { isValidPublicHostname, safeFetch } from '../../net/safe-fetch.js'
import type { OrderItem, ProductItem, ShopPlatform, TestConnectionResult } from '../platform.js'

// ── WooCommerce REST API types (subset) ──────────────────────────────────────

interface WcProduct {
  id: number
  sku: string
  name: string
  /** Current active price (string, may be sale price). */
  price: string
  regular_price: string
  stock_quantity: number | null
  manage_stock: boolean
  in_stock: boolean
}

interface WcOrderLineItem {
  sku: string | null
  quantity: number
  /** Unit gross price as a number. */
  price: number
}

interface WcOrder {
  id: number
  status: string
  billing: { first_name: string; last_name: string }
  date_created: string
  line_items: WcOrderLineItem[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function wcProductToItem(p: WcProduct): ProductItem {
  const priceStr = p.price || p.regular_price || '0'
  const priceGross = Math.round(parseFloat(priceStr) || 0)
  const stock = p.manage_stock
    ? Math.max(0, p.stock_quantity ?? 0)
    : p.in_stock
      ? 999
      : 0
  return {
    externalId: String(p.id),
    sku: p.sku ?? String(p.id),
    name: p.name ?? '',
    priceGross,
    stock,
  }
}

function wcOrderToItem(o: WcOrder): OrderItem {
  const firstName = o.billing?.first_name ?? ''
  const lastName = o.billing?.last_name ?? ''
  const customerName = [firstName, lastName].filter(Boolean).join(' ')
  return {
    externalId: String(o.id),
    status: o.status,
    customerName,
    items: (o.line_items ?? []).map((li) => ({
      sku: li.sku ?? '',
      qty: li.quantity ?? 1,
      priceGross: Math.round(li.price ?? 0),
    })),
    createdAt: o.date_created,
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class WooCommerceAdapter implements ShopPlatform {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly doFetch: FetchFn

  /**
   * @param config      Non-sensitive config from shop_connections.config — expects { domain: string }
   * @param credentials Decrypted credentials — expects { consumerKey: string, consumerSecret: string }
   * @param fetchFn     Injectable fetch (defaults to safeFetch). Pass a mock in tests.
   * @throws            When domain is missing or not a valid public hostname.
   */
  constructor(
    config: Record<string, unknown>,
    credentials: Record<string, string>,
    fetchFn?: FetchFn,
  ) {
    const domain = String(config.domain ?? '').toLowerCase()
    if (!isValidPublicHostname(domain)) {
      throw new Error(`WooCommerce: érvénytelen domain: "${domain}" — nyilvános, FQDN-formátumú domaint várunk`)
    }
    this.baseUrl = `https://${domain}/wp-json/wc/v3`
    this.authHeader = 'Basic ' + Buffer.from(`${credentials.consumerKey ?? ''}:${credentials.consumerSecret ?? ''}`).toString('base64')
    this.doFetch = fetchFn ?? safeFetch
  }

  // ── Private request helpers ────────────────────────────────────────────────

  private async apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    }
    const res = await this.doFetch(url.toString(), {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`WooCommerce API hiba (${res.status}): GET ${path}`)
    }
    return res.json() as Promise<T>
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`WooCommerce API hiba (${res.status}): POST ${path}`)
    }
    return res.json() as Promise<T>
  }

  private async apiPut<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`WooCommerce API hiba (${res.status}): PUT ${path}`)
    }
    return res.json() as Promise<T>
  }

  // ── ShopPlatform methods ───────────────────────────────────────────────────

  /**
   * Test the connection.
   * Tries GET /system_status first (requires manage_woocommerce capability).
   * Falls back to GET /products?per_page=1 if that fails.
   * Never throws — returns { ok: false, error } on failure.
   */
  async testConnection(): Promise<TestConnectionResult> {
    try {
      // system_status returns store info including total_products
      type SysStatus = { store?: { total_products?: number } }
      try {
        const s = await this.apiGet<SysStatus>('/system_status')
        return {
          ok: true,
          mode: 'live',
          productCount: s?.store?.total_products,
        }
      } catch {
        // system_status may require manage_woocommerce capability — fall back to listing
      }
      const products = await this.apiGet<WcProduct[]>('/products', { per_page: '1' })
      return {
        ok: true,
        mode: 'live',
        productCount: Array.isArray(products) ? products.length : 0,
      }
    } catch (err) {
      return { ok: false, mode: 'live', error: (err as Error).message }
    }
  }

  /** List all published products, paginated (up to 100 per page). */
  async listProducts(): Promise<ProductItem[]> {
    const all: ProductItem[] = []
    let page = 1
    for (;;) {
      const chunk = await this.apiGet<WcProduct[]>('/products', {
        per_page: '100',
        page: String(page),
        status: 'publish',
      })
      if (!Array.isArray(chunk) || chunk.length === 0) break
      for (const p of chunk) all.push(wcProductToItem(p))
      if (chunk.length < 100) break
      page++
    }
    return all
  }

  /**
   * Push a product: looks up by SKU and updates if found, creates otherwise.
   * Returns the WooCommerce product ID as externalId.
   */
  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    // Check for existing product by SKU
    const existing = await this.apiGet<WcProduct[]>('/products', { sku: p.sku })
    if (Array.isArray(existing) && existing.length > 0) {
      const id = existing[0].id
      await this.apiPut<WcProduct>(`/products/${id}`, {
        regular_price: String(p.priceGross),
        stock_quantity: p.stock,
        manage_stock: true,
      })
      return { externalId: String(id) }
    }
    // Create new product
    const created = await this.apiPost<WcProduct>('/products', {
      name: p.name,
      sku: p.sku,
      regular_price: String(p.priceGross),
      stock_quantity: p.stock,
      manage_stock: true,
      status: 'publish',
      type: 'simple',
    })
    return { externalId: String(created.id) }
  }

  /** Update price and stock of an existing product by its external (WooCommerce) ID. */
  async updatePriceStock(externalId: string, priceGross: number, stock: number): Promise<void> {
    await this.apiPut<WcProduct>(`/products/${externalId}`, {
      regular_price: String(priceGross),
      stock_quantity: stock,
      manage_stock: true,
    })
  }

  /** Fetch orders created at or after `since`, paginated. */
  async fetchOrders(since: Date): Promise<OrderItem[]> {
    const all: OrderItem[] = []
    let page = 1
    const after = since.toISOString()
    for (;;) {
      const chunk = await this.apiGet<WcOrder[]>('/orders', {
        after,
        per_page: '100',
        page: String(page),
        orderby: 'date',
        order: 'asc',
      })
      if (!Array.isArray(chunk) || chunk.length === 0) break
      for (const o of chunk) all.push(wcOrderToItem(o))
      if (chunk.length < 100) break
      page++
    }
    return all
  }

  /** List the most recent 50 orders. Legacy method. */
  async listOrders(): Promise<OrderItem[]> {
    const chunk = await this.apiGet<WcOrder[]>('/orders', {
      per_page: '50',
      orderby: 'date',
      order: 'desc',
    })
    return Array.isArray(chunk) ? chunk.map(wcOrderToItem) : []
  }
}
