/**
 * UNAS XML API adapter.
 *
 * UNAS XML API: https://unas.hu/tudasbazis/api
 * Authentication: POST XML to https://api.unas.eu/shop/ with Action: getToken header.
 * Token is then reused in every subsequent call via Authorization: Bearer <token>.
 *
 * credentials keys: { apiKey }
 * config keys: (none required)
 *
 * Network calls go through safeFetch (SSRF guard) by default;
 * inject a custom fetchFn as the third constructor arg for unit tests.
 */
import type { FetchFn } from '../../net/fetcher.js'
import { safeFetch } from '../../net/safe-fetch.js'
import type { OrderItem, ProductItem, ShopPlatform, TestConnectionResult } from '../platform.js'

const UNAS_ENDPOINT = 'https://api.unas.eu/shop/'

/** Escape XML special characters. Never interpolate user data into XML without this. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export class UnasAdapterStub implements ShopPlatform {
  private readonly apiKey: string
  private readonly fetchFn: FetchFn
  /** Cached session token; null = not yet obtained. */
  private token: string | null = null

  constructor(
    private readonly _config: Record<string, unknown>,
    credentials: Record<string, string>,
    fetchFn?: FetchFn,
  ) {
    this.apiKey = credentials.apiKey ?? ''
    this.fetchFn = fetchFn ?? safeFetch
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  /** Obtain (and cache) a session token from UNAS. */
  private async getToken(): Promise<string> {
    if (this.token) return this.token
    // https://unas.hu/tudasbazis/api — Bejelentkezés
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Params><ApiKey>${escapeXml(this.apiKey)}</ApiKey></Params>`
    const res = await this.fetchFn(UNAS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', Action: 'getToken' },
      body: xml,
    })
    if (!res.ok) throw new Error(`UNAS login hiba (${res.status})`)
    const text = await res.text()
    const match = text.match(/<Token>([^<]+)<\/Token>/)
    if (!match) throw new Error('UNAS: token nem érkezett')
    this.token = match[1]
    return this.token
  }

  /** POST an authenticated XML payload to the UNAS API and return the response text. */
  private async callXml(action: string, body: string): Promise<string> {
    const token = await this.getToken()
    const res = await this.fetchFn(UNAS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        Action: action,
        Authorization: `Bearer ${token}`,
      },
      body,
    })
    if (!res.ok) throw new Error(`UNAS API hiba (${res.status}): ${action}`)
    return res.text()
  }

  // ── ShopPlatform interface ──────────────────────────────────────────────────

  /** Test connectivity; never throws — wraps any error in { ok: false }. */
  async testConnection(): Promise<TestConnectionResult> {
    try {
      const products = await this.listProducts()
      return { ok: true, mode: 'live', productCount: products.length }
    } catch (err) {
      return { ok: false, mode: 'live', error: (err as Error).message }
    }
  }

  /**
   * List active products from UNAS.
   * https://unas.hu/tudasbazis/api — getProduct action
   */
  async listProducts(): Promise<ProductItem[]> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Params><StatusBase>1</StatusBase></Params>`
    const text = await this.callXml('getProduct', xml)
    const items: ProductItem[] = []
    for (const m of text.matchAll(/<Product>([\s\S]*?)<\/Product>/g)) {
      const block = m[1]
      const sku   = block.match(/<Sku>([^<]+)<\/Sku>/)?.[1]        ?? ''
      const name  = block.match(/<Name>([^<]+)<\/Name>/)?.[1]       ?? ''
      const price = parseFloat(block.match(/<PriceSale>([^<]+)<\/PriceSale>/)?.[1] ?? '0')
      const stock = parseInt(  block.match(/<Stock>([^<]+)<\/Stock>/)?.[1]          ?? '0', 10)
      if (sku) items.push({ externalId: sku, sku, name, priceGross: Math.round(price), stock })
    }
    return items
  }

  /**
   * Push (create or update) a product via setProduct.
   * https://unas.hu/tudasbazis/api — setProduct action
   * Returns the product's SKU as externalId (UNAS uses SKU as the stable key).
   */
  async pushProduct(p: ProductItem): Promise<{ externalId: string }> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><Products><Product>` +
      `<Sku>${escapeXml(p.sku)}</Sku>` +
      `<Name>${escapeXml(p.name)}</Name>` +
      `<PriceSale>${p.priceGross}</PriceSale>` +
      `<Stock>${p.stock}</Stock>` +
      `</Product></Products>`
    await this.callXml('setProduct', xml)
    return { externalId: p.sku }
  }

  /**
   * Update the gross price and stock level for an existing product.
   * https://unas.hu/tudasbazis/api — setProduct action
   * @param sku  The product's SKU (used as the UNAS external identifier).
   */
  async updatePriceStock(sku: string, priceGross: number, stock: number): Promise<void> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><Products><Product>` +
      `<Sku>${escapeXml(sku)}</Sku>` +
      `<PriceSale>${priceGross}</PriceSale>` +
      `<Stock>${stock}</Stock>` +
      `</Product></Products>`
    await this.callXml('setProduct', xml)
  }

  /**
   * Fetch orders created at or after `since` (client-side filter over listOrders).
   */
  async fetchOrders(since: Date): Promise<OrderItem[]> {
    const all = await this.listOrders()
    return all.filter((o) => new Date(o.createdAt) >= since)
  }

  /**
   * List the last 50 orders.
   * https://unas.hu/tudasbazis/api — getOrder action
   */
  async listOrders(): Promise<OrderItem[]> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Params><Limit>50</Limit></Params>`
    const text = await this.callXml('getOrder', xml)
    const items: OrderItem[] = []
    for (const m of text.matchAll(/<Order>([\s\S]*?)<\/Order>/g)) {
      const block = m[1]
      const id        = block.match(/<Id>([^<]+)<\/Id>/)?.[1]                     ?? ''
      const status    = block.match(/<Status>([^<]+)<\/Status>/)?.[1]              ?? ''
      const name      = block.match(/<CustomerName>([^<]+)<\/CustomerName>/)?.[1]  ?? ''
      const createdAt = block.match(/<Date>([^<]+)<\/Date>/)?.[1]                  ?? ''
      const orderItems: OrderItem['items'] = []
      for (const pm of block.matchAll(/<OrderProduct>([\s\S]*?)<\/OrderProduct>/g)) {
        const pb  = pm[1]
        const pSku = pb.match(/<Sku>([^<]+)<\/Sku>/)?.[1]                             ?? ''
        const qty  = parseInt(pb.match(/<Quantity>([^<]+)<\/Quantity>/)?.[1]           ?? '1', 10)
        const price = Math.round(parseFloat(pb.match(/<PriceSale>([^<]+)<\/PriceSale>/)?.[1] ?? '0'))
        if (pSku) orderItems.push({ sku: pSku, qty, priceGross: price })
      }
      if (id) items.push({ externalId: id, status, customerName: name, items: orderItems, createdAt })
    }
    return items
  }
}
