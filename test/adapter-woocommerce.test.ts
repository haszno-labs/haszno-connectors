/**
 * Unit tests for WooCommerceAdapter.
 * All fetch calls are mocked — no network or DNS involved.
 */

import { describe, expect, it, vi } from 'vitest'
import type { FetchFn } from '../src/net/fetcher.js'
import { WooCommerceAdapter } from '../src/connectors/adapters/woocommerce.js'

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockResp = Awaited<ReturnType<FetchFn>>

function ok(data: unknown): MockResp {
  return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data }
}

function fail(status: number): MockResp {
  return { ok: false, status, text: async () => '', json: async () => ({}) }
}

/** Build a WooCommerceAdapter wired to a custom mock fetch. */
function makeAdapter(fetchFn: FetchFn): WooCommerceAdapter {
  return new WooCommerceAdapter(
    { domain: 'shop.example.com' },
    { consumerKey: 'ck_test_key', consumerSecret: 'cs_test_secret' },
    fetchFn,
  )
}

// ── Sample fixtures ───────────────────────────────────────────────────────────

const WC_PRODUCT_1 = {
  id: 10,
  sku: 'CHAIR-001',
  name: 'Irodai szék',
  price: '12700',
  regular_price: '14900',
  stock_quantity: 5,
  manage_stock: true,
  in_stock: true,
}

const WC_PRODUCT_2 = {
  id: 11,
  sku: 'TABLE-002',
  name: 'Íróasztal',
  price: '49900',
  regular_price: '49900',
  stock_quantity: null,
  manage_stock: false,
  in_stock: true,
}

const WC_ORDER_1 = {
  id: 100,
  status: 'processing',
  billing: { first_name: 'Teszt', last_name: 'Ügyfél' },
  date_created: '2026-11-01T10:00:00',
  line_items: [{ sku: 'CHAIR-001', quantity: 2, price: 12700 }],
}

// ── Constructor validation ────────────────────────────────────────────────────

describe('WooCommerceAdapter constructor', () => {
  it('throws for an empty domain', () => {
    expect(() => new WooCommerceAdapter({ domain: '' }, {}, vi.fn() as unknown as FetchFn)).toThrow()
  })

  it('throws for a localhost domain', () => {
    expect(() => new WooCommerceAdapter({ domain: 'localhost' }, {}, vi.fn() as unknown as FetchFn)).toThrow()
  })

  it('throws for an IP address', () => {
    expect(() => new WooCommerceAdapter({ domain: '192.168.1.1' }, {}, vi.fn() as unknown as FetchFn)).toThrow()
  })

  it('throws for a single-label host', () => {
    expect(() => new WooCommerceAdapter({ domain: 'intranet' }, {}, vi.fn() as unknown as FetchFn)).toThrow()
  })

  it('accepts a valid public domain', () => {
    expect(() =>
      new WooCommerceAdapter(
        { domain: 'shop.example.com' },
        { consumerKey: 'ck', consumerSecret: 'cs' },
        vi.fn() as unknown as FetchFn,
      ),
    ).not.toThrow()
  })
})

// ── testConnection ────────────────────────────────────────────────────────────

describe('testConnection', () => {
  it('returns ok via system_status when available', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ store: { total_products: 42 } }))
    const result = await makeAdapter(fetch as unknown as FetchFn).testConnection()
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('live')
    expect(result.productCount).toBe(42)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toContain('/system_status')
  })

  it('falls back to products list when system_status fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(fail(403))                          // system_status → 403
      .mockResolvedValueOnce(ok([WC_PRODUCT_1]))                // products?per_page=1
    const result = await makeAdapter(fetch as unknown as FetchFn).testConnection()
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('live')
    expect(result.productCount).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toContain('/products')
    expect(fetch.mock.calls[1][0]).toContain('per_page=1')
  })

  it('returns ok: false when both endpoints fail', async () => {
    const fetch = vi.fn().mockResolvedValue(fail(401))
    const result = await makeAdapter(fetch as unknown as FetchFn).testConnection()
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('live')
    expect(result.error).toBeTruthy()
  })

  it('returns ok: false when fetch throws (network error)', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    const result = await makeAdapter(fetch as unknown as FetchFn).testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/connection refused/)
  })
})

// ── listProducts ──────────────────────────────────────────────────────────────

describe('listProducts', () => {
  it('maps WooCommerce products to ProductItem', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([WC_PRODUCT_1, WC_PRODUCT_2]))
    const products = await makeAdapter(fetch as unknown as FetchFn).listProducts()
    expect(products).toHaveLength(2)

    const p1 = products[0]
    expect(p1.externalId).toBe('10')
    expect(p1.sku).toBe('CHAIR-001')
    expect(p1.name).toBe('Irodai szék')
    expect(p1.priceGross).toBe(12700)   // current price field
    expect(p1.stock).toBe(5)

    // manage_stock=false but in_stock=true → 999
    const p2 = products[1]
    expect(p2.externalId).toBe('11')
    expect(p2.priceGross).toBe(49900)
    expect(p2.stock).toBe(999)
  })

  it('requests published products with per_page=100', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([WC_PRODUCT_1]))
    await makeAdapter(fetch as unknown as FetchFn).listProducts()
    const url = fetch.mock.calls[0][0] as string
    expect(url).toContain('per_page=100')
    expect(url).toContain('status=publish')
  })

  it('paginates when first page is full (100 items)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...WC_PRODUCT_1, id: i + 1, sku: `SKU-${i + 1}` }))
    const page2 = [{ ...WC_PRODUCT_1, id: 101, sku: 'SKU-101' }]
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(page1))
      .mockResolvedValueOnce(ok(page2))
    const products = await makeAdapter(fetch as unknown as FetchFn).listProducts()
    expect(products).toHaveLength(101)
    expect(fetch).toHaveBeenCalledTimes(2)
    // Second call should use page=2
    expect(fetch.mock.calls[1][0]).toContain('page=2')
  })

  it('handles empty product list', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([]))
    const products = await makeAdapter(fetch as unknown as FetchFn).listProducts()
    expect(products).toHaveLength(0)
    expect(fetch).toHaveBeenCalledOnce()
  })
})

// ── pushProduct ───────────────────────────────────────────────────────────────

describe('pushProduct', () => {
  const newProduct = { externalId: '', sku: 'NEW-001', name: 'Új termék', priceGross: 7900, stock: 20 }

  it('creates a new product when SKU is not found', async () => {
    const createdProduct = { ...WC_PRODUCT_1, id: 99, sku: 'NEW-001', name: 'Új termék', price: '7900', regular_price: '7900' }
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok([]))             // GET /products?sku=NEW-001 → not found
      .mockResolvedValueOnce(ok(createdProduct)) // POST /products
    const result = await makeAdapter(fetch as unknown as FetchFn).pushProduct(newProduct)
    expect(result.externalId).toBe('99')
    // First call: GET with sku param
    expect(fetch.mock.calls[0][0]).toContain('sku=NEW-001')
    // Second call: POST
    expect(fetch.mock.calls[1][1]?.method).toBe('POST')
    const sentBody = JSON.parse(fetch.mock.calls[1][1]?.body as string)
    expect(sentBody.sku).toBe('NEW-001')
    expect(sentBody.regular_price).toBe('7900')
    expect(sentBody.stock_quantity).toBe(20)
  })

  it('updates existing product when SKU is found', async () => {
    const existingProduct = { ...WC_PRODUCT_1, id: 42, sku: 'CHAIR-001' }
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok([existingProduct]))   // GET /products?sku=CHAIR-001 → found
      .mockResolvedValueOnce(ok(existingProduct))     // PUT /products/42
    const toUpdate = { externalId: '42', sku: 'CHAIR-001', name: 'Irodai szék', priceGross: 11900, stock: 3 }
    const result = await makeAdapter(fetch as unknown as FetchFn).pushProduct(toUpdate)
    expect(result.externalId).toBe('42')
    // Second call: PUT to /products/42
    expect(fetch.mock.calls[1][1]?.method).toBe('PUT')
    expect(fetch.mock.calls[1][0]).toContain('/products/42')
    const sentBody = JSON.parse(fetch.mock.calls[1][1]?.body as string)
    expect(sentBody.regular_price).toBe('11900')
    expect(sentBody.stock_quantity).toBe(3)
  })
})

// ── updatePriceStock ──────────────────────────────────────────────────────────

describe('updatePriceStock', () => {
  it('calls PUT /products/{id} with price and stock', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ ...WC_PRODUCT_1, id: 10 }))
    await makeAdapter(fetch as unknown as FetchFn).updatePriceStock('10', 15900, 8)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toContain('/products/10')
    expect(fetch.mock.calls[0][1]?.method).toBe('PUT')
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body.regular_price).toBe('15900')
    expect(body.stock_quantity).toBe(8)
    expect(body.manage_stock).toBe(true)
  })

  it('throws on API error', async () => {
    const fetch = vi.fn().mockResolvedValue(fail(404))
    await expect(
      makeAdapter(fetch as unknown as FetchFn).updatePriceStock('999', 1000, 0),
    ).rejects.toThrow(/404/)
  })
})

// ── fetchOrders ───────────────────────────────────────────────────────────────

describe('fetchOrders', () => {
  it('fetches orders and maps them correctly', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([WC_ORDER_1]))
    const since = new Date('2026-11-01T00:00:00Z')
    const orders = await makeAdapter(fetch as unknown as FetchFn).fetchOrders(since)
    expect(orders).toHaveLength(1)
    const o = orders[0]
    expect(o.externalId).toBe('100')
    expect(o.status).toBe('processing')
    expect(o.customerName).toBe('Teszt Ügyfél')
    expect(o.items).toHaveLength(1)
    expect(o.items[0].sku).toBe('CHAIR-001')
    expect(o.items[0].qty).toBe(2)
    expect(o.items[0].priceGross).toBe(12700)
    expect(o.createdAt).toBe('2026-11-01T10:00:00')
  })

  it('passes the after param as ISO string', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([]))
    const since = new Date('2026-10-15T12:00:00Z')
    await makeAdapter(fetch as unknown as FetchFn).fetchOrders(since)
    const url = fetch.mock.calls[0][0] as string
    expect(url).toContain('after=')
    expect(url).toContain(encodeURIComponent(since.toISOString()).replace(/%3A/g, '%3A'))
  })

  it('paginates when first page is full (100 orders)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ ...WC_ORDER_1, id: i + 1 }))
    const page2 = [{ ...WC_ORDER_1, id: 101 }]
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(page1))
      .mockResolvedValueOnce(ok(page2))
    const orders = await makeAdapter(fetch as unknown as FetchFn).fetchOrders(new Date('2026-01-01'))
    expect(orders).toHaveLength(101)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns empty array when no orders match', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([]))
    const orders = await makeAdapter(fetch as unknown as FetchFn).fetchOrders(new Date())
    expect(orders).toHaveLength(0)
  })
})

// ── listOrders ────────────────────────────────────────────────────────────────

describe('listOrders', () => {
  it('fetches recent 50 orders', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([WC_ORDER_1]))
    const orders = await makeAdapter(fetch as unknown as FetchFn).listOrders()
    expect(orders).toHaveLength(1)
    expect(fetch).toHaveBeenCalledOnce()
    const url = fetch.mock.calls[0][0] as string
    expect(url).toContain('per_page=50')
    expect(url).toContain('order=desc')
  })

  it('handles empty response', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([]))
    const orders = await makeAdapter(fetch as unknown as FetchFn).listOrders()
    expect(orders).toHaveLength(0)
  })
})

// ── Authorization header ──────────────────────────────────────────────────────

describe('Authorization header', () => {
  it('sends Basic auth with base64-encoded key:secret', async () => {
    const fetch = vi.fn().mockResolvedValue(ok([]))
    const adapter = new WooCommerceAdapter(
      { domain: 'shop.example.com' },
      { consumerKey: 'ck_mykey', consumerSecret: 'cs_mysecret' },
      fetch as unknown as FetchFn,
    )
    await adapter.listOrders()
    const init = fetch.mock.calls[0][1] as RequestInit
    const authHeader = (init.headers as Record<string, string>)['Authorization']
    expect(authHeader).toMatch(/^Basic /)
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8')
    expect(decoded).toBe('ck_mykey:cs_mysecret')
  })
})
