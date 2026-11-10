/**
 * Shoprenter adapter unit tests — no real network.
 *
 * All HTTP calls are intercepted via an injected FetchFn so this suite runs
 * fully offline and does not touch any database.
 *
 * Tests:
 *  1. listProducts: paginates through multiple pages until page smaller than limit.
 *  2. listProducts: returns empty array when first page is empty.
 *  3. listProducts: converts net price to gross (×1.27, 27% VAT).
 *  4. pushProduct: finds existing product by SKU and updates price+stock (PUT).
 *  5. pushProduct: creates product when SKU not found (POST).
 *  6. pushProduct: returns externalId from existing product on update.
 *  7. pushProduct: returns externalId from created product.
 *  8. updatePriceStock: finds product by SKU and PUTs price+stock.
 *  9. updatePriceStock: throws when SKU not found.
 * 10. listOrders: parses order list including nested orderProducts.
 * 11. fetchOrders: filters orders by since date.
 * 12. testConnection: returns ok:true with productCount on success.
 * 13. testConnection: returns ok:false with error on failure.
 * 14. testConnection: never throws.
 * 15. Rate-limit retry: retries once on 429 response.
 * 16. safeFetch injection: custom fetchFn is used instead of global fetch.
 */
import { describe, expect, it, vi } from 'vitest'
import type { FetchFn } from '../src/net/fetcher.js'
import { ShoprenterAdapter } from '../src/connectors/platform.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRODUCTS_PAGE_1 = JSON.stringify({
  items: Array.from({ length: 100 }, (_, i) => ({
    id: `sr-${i + 1}`,
    sku: `SKU-${String(i + 1).padStart(3, '0')}`,
    price: '1000.0000', // net price
    stock: '5',
  })),
})

const PRODUCTS_PAGE_2 = JSON.stringify({
  items: [
    { id: 'sr-101', sku: 'SKU-101', price: '2000.0000', stock: '10' },
    { id: 'sr-102', sku: 'SKU-102', price: '3000.0000', stock: '0' },
  ],
})

const PRODUCTS_EMPTY = JSON.stringify({ items: [] })

const ORDERS_RESPONSE = JSON.stringify({
  items: [
    {
      id: 'ORD-100',
      status: 'feldolgozás alatt',
      customer: { firstname: 'Kovács', lastname: 'János' },
      dateCreated: '2026-11-01T10:00:00Z',
      orderProducts: [{ sku: 'SKU-001', quantity: '2', grossPrice: '12700' }],
    },
    {
      id: 'ORD-101',
      status: 'teljesítve',
      customer: { firstname: 'Nagy', lastname: 'Éva' },
      dateCreated: '2026-11-05T08:00:00Z',
      orderProducts: [{ sku: 'SKU-002', quantity: '1', grossPrice: '5000' }],
    },
  ],
})

const SKU_FOUND_RESPONSE = JSON.stringify({ items: [{ id: 'sr-42', sku: 'SKU-EXIST' }] })
const SKU_NOT_FOUND_RESPONSE = JSON.stringify({ items: [] })
const UPDATE_OK_RESPONSE = JSON.stringify({ id: 'sr-42', sku: 'SKU-EXIST' })
const CREATE_RESPONSE = JSON.stringify({ id: 'sr-new-99' })
const ERROR_404 = JSON.stringify({ message: 'Not found' })

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockResponse = { status?: number; body: string }

function makeAdapter(responses: MockResponse[], shopName = 'testbolt'): { adapter: ShoprenterAdapter; calls: string[] } {
  const calls: string[] = []
  let idx = 0
  const mockFetch: FetchFn = async (url) => {
    calls.push(url as string)
    const r = responses[Math.min(idx++, responses.length - 1)]
    const status = r.status ?? 200
    const body = r.body
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    }
  }
  const adapter = new ShoprenterAdapter(shopName, 'testuser', 'testkey', mockFetch)
  return { adapter, calls }
}

function makeRoutedAdapter(routes: Record<string, MockResponse | string>): { adapter: ShoprenterAdapter; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const mockFetch: FetchFn = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body as string | undefined
    calls.push({ url: url as string, method, body })
    // Route by URL path fragment (after the base URL)
    const path = new URL(url as string).pathname + new URL(url as string).search
    for (const [key, entry] of Object.entries(routes)) {
      if (path.includes(key)) {
        const resolved = typeof entry === 'string' ? { status: 200 as number, body: entry } : { status: entry.status ?? 200, body: entry.body }
        return {
          ok: resolved.status >= 200 && resolved.status < 300,
          status: resolved.status,
          text: async () => resolved.body,
          json: async () => JSON.parse(resolved.body) as unknown,
        }
      }
    }
    return { ok: false, status: 404, text: async () => ERROR_404, json: async () => ({ message: 'Not found' }) }
  }
  const adapter = new ShoprenterAdapter('testbolt', 'testuser', 'testkey', mockFetch)
  return { adapter, calls }
}

// ── 1–3. listProducts ─────────────────────────────────────────────────────────

describe('ShoprenterAdapter — listProducts', () => {
  it('paginates through multiple pages until page is smaller than limit', async () => {
    const { adapter } = makeAdapter([
      { body: PRODUCTS_PAGE_1 }, // page 1: 100 items → fetch page 2
      { body: PRODUCTS_PAGE_2 }, // page 2: 2 items → stop
    ])
    const products = await adapter.listProducts()
    expect(products).toHaveLength(102)
  })

  it('returns empty array when first page is empty', async () => {
    const { adapter } = makeAdapter([{ body: PRODUCTS_EMPTY }])
    expect(await adapter.listProducts()).toEqual([])
  })

  it('converts net price to gross HUF (net × 1.27, 27% VAT)', async () => {
    const { adapter } = makeAdapter([
      { body: JSON.stringify({ items: [{ id: 'sr-1', sku: 'SKU-001', price: '1000.0000', stock: '5' }] }) },
    ])
    const products = await adapter.listProducts()
    // net 1000 × 1.27 = 1270.00 → round → 1270
    expect(products[0].priceGross).toBe(1270)
  })
})

// ── 4–7. pushProduct ──────────────────────────────────────────────────────────

describe('ShoprenterAdapter — pushProduct', () => {
  it('finds existing product by SKU and PUTs price+stock (update path)', async () => {
    const { adapter, calls } = makeRoutedAdapter({
      '/api/products?sku=': SKU_FOUND_RESPONSE,
      '/api/products/sr-42': UPDATE_OK_RESPONSE,
    })
    const result = await adapter.pushProduct({ externalId: '', sku: 'SKU-EXIST', name: 'Termék', priceGross: 12700, stock: 3 })
    expect(result).toEqual({ externalId: 'sr-42' })
    const putCall = calls.find((c) => c.method === 'PUT')
    expect(putCall).toBeDefined()
    expect(putCall!.url).toContain('/api/products/sr-42')
    // price must be net (gross 12700 ÷ 1.27 ≈ 10000)
    const body = JSON.parse(putCall!.body ?? '{}') as { price: string; stock: string }
    expect(parseFloat(body.price)).toBeCloseTo(10000, 1)
    expect(body.stock).toBe('3')
  })

  it('creates product when SKU not found (POST path)', async () => {
    const { adapter, calls } = makeRoutedAdapter({
      '/api/products?sku=': SKU_NOT_FOUND_RESPONSE,
      '/api/products': CREATE_RESPONSE,
    })
    const result = await adapter.pushProduct({ externalId: '', sku: 'SKU-NEW', name: 'Új termék', priceGross: 9900, stock: 10 })
    expect(result).toEqual({ externalId: 'sr-new-99' })
    const postCall = calls.find((c) => c.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall!.body ?? '{}') as { sku: string; price: string; stock: string }
    expect(body.sku).toBe('SKU-NEW')
    expect(parseFloat(body.price)).toBeCloseTo(9900 / 1.27, 1)
    expect(body.stock).toBe('10')
  })

  it('is idempotent: calling pushProduct twice updates (not creates) on second call', async () => {
    let callCount = 0
    const mockFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      callCount++
      if (method === 'GET') {
        // After first create, SKU now exists
        const body = callCount <= 2 ? SKU_NOT_FOUND_RESPONSE : SKU_FOUND_RESPONSE
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
      }
      if (method === 'POST') return { ok: true, status: 201, text: async () => CREATE_RESPONSE, json: async () => JSON.parse(CREATE_RESPONSE) }
      if (method === 'PUT') return { ok: true, status: 200, text: async () => UPDATE_OK_RESPONSE, json: async () => JSON.parse(UPDATE_OK_RESPONSE) }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }
    const adapter = new ShoprenterAdapter('testbolt', 'testuser', 'testkey', mockFetch)
    const r1 = await adapter.pushProduct({ externalId: '', sku: 'SKU-X', name: 'X', priceGross: 1000, stock: 1 })
    expect(r1.externalId).toBe('sr-new-99')
    const r2 = await adapter.pushProduct({ externalId: '', sku: 'SKU-X', name: 'X', priceGross: 2000, stock: 2 })
    expect(r2.externalId).toBe('sr-42')
  })
})

// ── 8–9. updatePriceStock ─────────────────────────────────────────────────────

describe('ShoprenterAdapter — updatePriceStock', () => {
  it('finds product by SKU and sends net price + stock via PUT', async () => {
    const { adapter, calls } = makeRoutedAdapter({
      '/api/products?sku=': SKU_FOUND_RESPONSE,
      '/api/products/sr-42': UPDATE_OK_RESPONSE,
    })
    await adapter.updatePriceStock('SKU-EXIST', 12700, 5)
    const putCall = calls.find((c) => c.method === 'PUT')
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall!.body ?? '{}') as { price: string; stock: string }
    expect(parseFloat(body.price)).toBeCloseTo(12700 / 1.27, 1)
    expect(body.stock).toBe('5')
  })

  it('throws when SKU is not found', async () => {
    const { adapter } = makeRoutedAdapter({
      '/api/products?sku=': SKU_NOT_FOUND_RESPONSE,
    })
    await expect(adapter.updatePriceStock('MISSING-SKU', 1000, 1)).rejects.toThrow(/nem található/)
  })
})

// ── 10–11. listOrders / fetchOrders ──────────────────────────────────────────

describe('ShoprenterAdapter — listOrders / fetchOrders', () => {
  it('parses order list including nested orderProducts', async () => {
    const { adapter } = makeAdapter([{ body: ORDERS_RESPONSE }])
    const orders = await adapter.listOrders()
    expect(orders).toHaveLength(2)
    expect(orders[0]).toMatchObject({
      externalId: 'ORD-100',
      status: 'feldolgozás alatt',
      customerName: 'Kovács János',
      createdAt: '2026-11-01T10:00:00Z',
    })
    expect(orders[0].items).toHaveLength(1)
    expect(orders[0].items[0]).toMatchObject({ sku: 'SKU-001', qty: 2, priceGross: 12700 })
  })

  it('fetchOrders filters by since date', async () => {
    const { adapter } = makeAdapter([{ body: ORDERS_RESPONSE }])
    // ORD-100 = 2026-11-01, ORD-101 = 2026-11-05 → only ORD-101 at/after 2026-11-04
    const orders = await adapter.fetchOrders(new Date('2026-11-04T00:00:00Z'))
    expect(orders).toHaveLength(1)
    expect(orders[0].externalId).toBe('ORD-101')
  })
})

// ── 12–14. testConnection ─────────────────────────────────────────────────────

describe('ShoprenterAdapter — testConnection', () => {
  it('returns ok:true with mode:live and productCount on success', async () => {
    const { adapter } = makeAdapter([{ body: PRODUCTS_EMPTY }])
    const result = await adapter.testConnection()
    expect(result).toMatchObject({ ok: true, mode: 'live', productCount: 0 })
  })

  it('returns ok:false with error on HTTP failure', async () => {
    const { adapter } = makeAdapter([{ status: 401, body: JSON.stringify({ message: 'Unauthorized' }) }])
    const result = await adapter.testConnection()
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('live')
    expect(typeof result.error).toBe('string')
  })

  it('never throws even when connection fails', async () => {
    let calls = 0
    const mockFetch: FetchFn = async () => {
      calls++
      throw new Error('ECONNREFUSED')
    }
    const adapter = new ShoprenterAdapter('testbolt', 'user', 'key', mockFetch)
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, mode: 'live' })
    // withRetry retries on 429 only; network errors rethrow immediately → 1 call
    expect(calls).toBe(1)
  })
})

// ── 15. Rate-limit retry ──────────────────────────────────────────────────────

describe('ShoprenterAdapter — rate-limit retry', () => {
  it('retries once on 429 and succeeds on the second attempt', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const mockFetch: FetchFn = async () => {
      attempt++
      if (attempt === 1) {
        return { ok: false, status: 429, text: async () => 'Too Many Requests', json: async () => ({}) }
      }
      return { ok: true, status: 200, text: async () => PRODUCTS_EMPTY, json: async () => JSON.parse(PRODUCTS_EMPTY) }
    }
    const adapter = new ShoprenterAdapter('testbolt', 'user', 'key', mockFetch)
    const promise = adapter.listProducts()
    // Advance past the 1-second backoff
    await vi.runAllTimersAsync()
    const products = await promise
    expect(products).toEqual([])
    expect(attempt).toBe(2)
    vi.useRealTimers()
  })
})

// ── 16. safeFetch injection ───────────────────────────────────────────────────

describe('ShoprenterAdapter — safeFetch injection', () => {
  it('calls the injected fetchFn, not the global fetch', async () => {
    let injectedCalled = false
    const mockFetch: FetchFn = async () => {
      injectedCalled = true
      return { ok: true, status: 200, text: async () => PRODUCTS_EMPTY, json: async () => JSON.parse(PRODUCTS_EMPTY) }
    }
    const adapter = new ShoprenterAdapter('testbolt', 'user', 'key', mockFetch)
    await adapter.listProducts()
    expect(injectedCalled).toBe(true)
  })
})
