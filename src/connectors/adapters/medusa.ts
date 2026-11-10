/**
 * Medusa v2 Admin API adapter.
 *
 * Medusa v2 Admin API: https://docs.medusajs.com/api/admin
 * Authentication: HTTP Basic auth with the secret API key.
 *   Secret API keys MUST use Basic auth — sending them as Bearer returns 401.
 *   Format: Authorization: Basic base64(:<apiKey>)  (empty username, key as password)
 * Base URL: https://{domain}
 *
 * credentials keys: { apiKey } — Medusa Admin secret API key
 * config keys: { domain } — backend domain (e.g. admin.myshop.hu), SSRF-validated via safeFetch
 *
 * Prices are stored in HUF. Medusa amounts = gross HUF (HUF has no minor currency units).
 *
 * Testability: pass a `fetchFn` as the third constructor argument to inject a mock.
 * Production uses safeFetch (SSRF-guarded) by default.
 */
import type { FetchFn } from '../../net/fetcher.js'
import { isValidPublicHostname, safeFetch } from '../../net/safe-fetch.js'
import type { OrderItem, ProductItem, ShopPlatform, TestConnectionResult } from '../platform.js'

export class MedusaAdapter implements ShopPlatform {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly fetchFn: FetchFn

  constructor(
    config: Record<string, unknown>,
    credentials: Record<string, string>,
    fetchFn?: FetchFn,
  ) {
    const domain = String((config.domain as string | undefined) ?? '').toLowerCase()
    if (!domain) throw new Error('MedusaAdapter: hiányzik a config.domain')
    if (!isValidPublicHostname(domain)) {
      throw new Error(`MedusaAdapter: érvénytelen domain: "${domain}" — nyilvános, FQDN-formátumú domaint várunk`)
    }
    this.baseUrl = `https://${domain}`
    const apiKey = credentials.apiKey ?? ''
    // Medusa v2: Basic auth — empty username, API key as password (base64(":" + apiKey))
    this.authHeader = `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`
    this.fetchFn = fetchFn ?? safeFetch
  }

  // ── Internal fetch helper ────────────────────────────────────────────────────

  private async apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Medusa API hiba (${res.status}): ${errText}`)
    }
    return res.json() as Promise<T>
  }

  // ── ShopPlatform methods ─────────────────────────────────────────────────────

  /**
   * Test reachability and auth via GET /admin/stores.
   * Never throws — wraps all errors into { ok: false, error }.
   */
  async testConnection(): Promise<TestConnectionResult> {
    try {
      type StoresResponse = { store?: { name?: string }; stores?: { name?: string }[] }
      const storeData = await this.apiFetch<StoresResponse>('/admin/stores')
      // Medusa v2 returns { store: {...} }; guard for older shape { stores: [...] }
      const hasStore =
        storeData.store != null ||
        (Array.isArray(storeData.stores) && storeData.stores.length > 0)
      if (!hasStore) {
        return { ok: false, mode: 'live', error: 'Érvénytelen válasz a /admin/stores végponttól' }
      }
      // Fetch a quick product count alongside the connectivity check.
      type ProductCountResponse = { count?: number; products?: unknown[] }
      const pData = await this.apiFetch<ProductCountResponse>('/admin/products?limit=1&fields=id')
      const productCount =
        typeof pData.count === 'number' ? pData.count : (pData.products?.length ?? 0)
      return { ok: true, mode: 'live', productCount }
    } catch (err) {
      return { ok: false, mode: 'live', error: (err as Error).message }
    }
  }

  /**
   * List all products from the Medusa store. Only products with a HUF price
   * on their first variant are returned. Paginates automatically.
   */
  async listProducts(): Promise<ProductItem[]> {
    type MedusaVariant = {
      id: string
      sku?: string | null
      prices?: { id: string; currency_code: string; amount: number }[]
      inventory_quantity?: number
    }
    type MedusaProduct = { id: string; title: string; variants?: MedusaVariant[] }
    type ProductListResponse = {
      products: MedusaProduct[]
      count: number
      limit: number
      offset: number
    }

    const items: ProductItem[] = []
    let offset = 0
    const limit = 50

    for (;;) {
      const data = await this.apiFetch<ProductListResponse>(
        `/admin/products?limit=${limit}&offset=${offset}&fields=id,title,variants.id,variants.sku,variants.prices,variants.inventory_quantity`,
      )
      for (const p of data.products) {
        const variant = p.variants?.[0]
        if (!variant) continue
        const hufPrice = variant.prices?.find(
          (pr) => pr.currency_code.toLowerCase() === 'huf',
        )?.amount
        if (hufPrice == null) continue
        items.push({
          externalId: p.id,
          sku: variant.sku ?? p.id,
          name: p.title,
          priceGross: hufPrice,
          stock: variant.inventory_quantity ?? 0,
        })
      }
      if (data.products.length < limit) break
      offset += limit
    }

    return items
  }

  /**
   * Push a product to Medusa. Searches by SKU first; updates the variant if found,
   * otherwise creates a new product via POST /admin/products with one variant.
   * Price is stored as HUF (currency_code: 'huf').
   */
  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    type VariantStub = { id: string; sku?: string | null }
    type ProductStub = { id: string; variants?: VariantStub[] }
    type ProductListResponse = { products: ProductStub[] }

    // Search for an existing product by SKU to avoid duplicates.
    const searchData = await this.apiFetch<ProductListResponse>(
      `/admin/products?q=${encodeURIComponent(p.sku)}&fields=id,variants.id,variants.sku`,
    )
    const existing = searchData.products.find((prod) =>
      prod.variants?.some((v) => v.sku === p.sku),
    )

    if (existing) {
      const variant = existing.variants?.find((v) => v.sku === p.sku)
      if (variant) {
        // Update the existing variant's HUF price.
        await this.apiFetch(`/admin/products/${existing.id}/variants/${variant.id}`, {
          method: 'POST',
          body: JSON.stringify({ prices: [{ currency_code: 'huf', amount: p.priceGross }] }),
        })
        return { externalId: existing.id }
      }
    }

    // Create a new product with one default variant.
    type CreateProductResponse = { product: { id: string } }
    const created = await this.apiFetch<CreateProductResponse>('/admin/products', {
      method: 'POST',
      body: JSON.stringify({
        title: p.name,
        status: 'published',
        variants: [
          {
            title: 'Default',
            sku: p.sku,
            manage_inventory: true,
            prices: [{ currency_code: 'huf', amount: p.priceGross }],
          },
        ],
      }),
    })
    return { externalId: created.product.id }
  }

  /**
   * Update the HUF price and stock level of a product by its external product ID.
   *
   * Price: updates (or adds) the HUF price entry on the first variant via
   *   POST /admin/products/{id}/variants/{variantId}
   * Stock: updates inventory levels via
   *   GET  /admin/inventory-items?variant_id=...
   *   POST /admin/inventory-items/{id}/location-levels/{location_id}
   * If no inventory item or location is configured, the stock update is skipped silently.
   */
  async updatePriceStock(externalId: string, priceGross: number, stock: number): Promise<void> {
    // 1. Retrieve product to get variant and current price IDs.
    type VariantFull = {
      id: string
      prices?: { id: string; currency_code: string; amount: number }[]
    }
    type ProductFull = { product: { id: string; variants?: VariantFull[] } }
    const productData = await this.apiFetch<ProductFull>(
      `/admin/products/${externalId}?fields=id,variants.id,variants.prices`,
    )
    const variant = productData.product.variants?.[0]
    if (!variant) throw new Error(`Nem találhatók variánsok a termékhez: ${externalId}`)

    // 2. Update or add HUF price.
    const hufPrice = variant.prices?.find((pr) => pr.currency_code.toLowerCase() === 'huf')
    const pricesPayload = hufPrice
      ? [{ id: hufPrice.id, amount: priceGross }]
      : [{ currency_code: 'huf', amount: priceGross }]

    await this.apiFetch(`/admin/products/${externalId}/variants/${variant.id}`, {
      method: 'POST',
      body: JSON.stringify({ prices: pricesPayload }),
    })

    // 3. Update inventory stock via inventory items API.
    type InventoryLevel = { id: string; location_id: string; stocked_quantity: number }
    type InventoryItem = { id: string; location_levels?: InventoryLevel[] }
    type InventoryListResponse = { inventory_items?: InventoryItem[] }

    const invData = await this.apiFetch<InventoryListResponse>(
      `/admin/inventory-items?variant_id=${variant.id}&fields=id,location_levels`,
    )
    const invItem = invData.inventory_items?.[0]
    if (!invItem) return // manage_inventory=false or no item — skip stock update

    const level = invItem.location_levels?.[0]
    if (!level) return // no location configured — cannot update without location_id

    await this.apiFetch(
      `/admin/inventory-items/${invItem.id}/location-levels/${level.location_id}`,
      { method: 'POST', body: JSON.stringify({ stocked_quantity: stock }) },
    )
  }

  /**
   * Fetch orders created at or after `since` via
   *   GET /admin/orders?created_at[$gt]={since.toISOString()}
   */
  async fetchOrders(since: Date): Promise<OrderItem[]> {
    // Encode created_at[$gt] filter — brackets must be percent-encoded in query strings.
    const isoDate = encodeURIComponent(since.toISOString())
    return this._fetchOrders(
      `/admin/orders?limit=50&created_at%5B%24gt%5D=${isoDate}`,
    )
  }

  /** List the last 50 orders (no date filter). Legacy method. */
  async listOrders(): Promise<OrderItem[]> {
    return this._fetchOrders('/admin/orders?limit=50')
  }

  private async _fetchOrders(path: string): Promise<OrderItem[]> {
    type MedusaLineItem = {
      id: string
      variant?: { sku?: string | null }
      quantity: number
      unit_price: number
    }
    type MedusaOrder = {
      id: string
      status: string
      customer?: { first_name?: string; last_name?: string }
      created_at: string
      items?: MedusaLineItem[]
    }
    type OrderListResponse = { orders: MedusaOrder[] }

    const data = await this.apiFetch<OrderListResponse>(path)
    return data.orders.map((o) => ({
      externalId: o.id,
      status: o.status,
      customerName:
        [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || 'Ismeretlen',
      items: (o.items ?? []).map((item) => ({
        sku: item.variant?.sku ?? item.id,
        qty: item.quantity,
        priceGross: item.unit_price,
      })),
      createdAt: o.created_at,
    }))
  }
}
