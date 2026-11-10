/**
 * MedusaAdapter unit tests.
 *
 * All HTTP calls are mocked — no real network traffic, no DB.
 *
 * Tests cover:
 *  1. testConnection — success and failure paths, never-throw contract
 *  2. listProducts  — pagination, HUF price selection, skips missing/non-HUF
 *  3. pushProduct   — create new vs update existing (SKU lookup)
 *  4. updatePriceStock — price update + inventory level, graceful skip when missing
 *  5. listOrders / fetchOrders — response mapping, date filter in URL
 *  6. Auth header   — Basic base64(:<apiKey>)
 *  7. Constructor validation
 */
import { describe, expect, it } from 'vitest'
import { MedusaAdapter } from '../src/connectors/adapters/medusa.js'
import type { FetchFn } from '../src/net/fetcher.js'

// ── Mock fetch builder ────────────────────────────────────────────────────────

type Fixture = { status?: number; body: unknown }

/**
 * Returns a FetchFn that matches URL substrings (and optionally HTTP method prefix
 * in the form "METHOD /url-fragment") against fixture keys.
 * Method+URL keys take priority over URL-only keys.
 * Unmatched requests return 404.
 */
function makeMockFetch(fixtures: Record<string, Fixture>): FetchFn {
  return async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    // Priority 1: "METHOD fragment" keys
    for (const [pattern, fixture] of Object.entries(fixtures)) {
      const spaceIdx = pattern.indexOf(' ')
      if (spaceIdx === -1) continue
      const keyMethod = pattern.slice(0, spaceIdx).toUpperCase()
      const keyFragment = pattern.slice(spaceIdx + 1)
      if (keyMethod === method && url.includes(keyFragment)) {
        const status = fixture.status ?? 200
        const bodyStr = JSON.stringify(fixture.body)
        return { ok: status < 400, status, text: async () => bodyStr, json: async () => fixture.body }
      }
    }
    // Priority 2: plain URL-fragment keys
    for (const [pattern, fixture] of Object.entries(fixtures)) {
      if (pattern.includes(' ')) continue
      if (url.includes(pattern)) {
        const status = fixture.status ?? 200
        const bodyStr = JSON.stringify(fixture.body)
        return { ok: status < 400, status, text: async () => bodyStr, json: async () => fixture.body }
      }
    }
    return {
      ok: false,
      status: 404,
      text: async () => `{"message":"mock: no fixture for ${method} ${url}"}`,
      json: async () => ({ message: `mock: no fixture for ${method} ${url}` }),
    }
  }
}

// ── Shared fixture data ───────────────────────────────────────────────────────

const DOMAIN = 'admin.testshop.example.hu'
const API_KEY = 'sk_test_abcdef123456'

const STORE_FIXTURE = { store: { id: 'store_1', name: 'Teszt Bolt', currency_code: 'huf' } }
const PRODUCTS_PAGE_FIXTURE = {
  products: [
    {
      id: 'prod_1',
      title: 'Termék 1',
      variants: [
        {
          id: 'var_1',
          sku: 'SKU-001',
          prices: [{ id: 'price_1', currency_code: 'huf', amount: 12700 }],
          inventory_quantity: 10,
        },
      ],
    },
    {
      id: 'prod_2',
      title: 'Termék 2',
      variants: [
        {
          id: 'var_2',
          sku: 'SKU-002',
          prices: [
            { id: 'price_2a', currency_code: 'eur', amount: 30 },
            { id: 'price_2b', currency_code: 'huf', amount: 11900 },
          ],
          inventory_quantity: 5,
        },
      ],
    },
  ],
  count: 2,
  limit: 50,
  offset: 0,
}
const ORDERS_FIXTURE = {
  orders: [
    {
      id: 'order_1',
      status: 'pending',
      customer: { first_name: 'Teszt', last_name: 'Ügyfél' },
      created_at: '2026-11-01T10:00:00Z',
      items: [
        { id: 'item_1', variant: { sku: 'SKU-001' }, quantity: 2, unit_price: 12700 },
      ],
    },
  ],
}

// ── 1. testConnection ─────────────────────────────────────────────────────────

describe('MedusaAdapter.testConnection', () => {
  it('returns ok=true with mode=live when /admin/stores and /admin/products respond', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({
        '/admin/stores': { body: STORE_FIXTURE },
        '/admin/products': { body: { products: [], count: 5 } },
      }),
    )
    const result = await adapter.testConnection()
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('live')
    expect(typeof result.productCount).toBe('number')
  })

  it('reports productCount from the count field', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({
        '/admin/stores': { body: STORE_FIXTURE },
        '/admin/products': { body: { products: [], count: 42 } },
      }),
    )
    const result = await adapter.testConnection()
    expect(result.productCount).toBe(42)
  })

  it('returns ok=false when /admin/stores returns 401', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: 'wrong-key' },
      makeMockFetch({
        '/admin/stores': { status: 401, body: { message: 'Unauthorized' } },
      }),
    )
    const result = await adapter.testConnection()
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('live')
    expect(result.error).toBeTruthy()
  })

  it('returns ok=false without throwing on network-level error', async () => {
    const failFetch: FetchFn = async () => {
      throw new Error('connection refused')
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, failFetch)
    const result = await adapter.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connection refused')
  })

  it('returns ok=false when store response has no store field', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/stores': { body: {} } }),
    )
    const result = await adapter.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// ── 2. listProducts ───────────────────────────────────────────────────────────

describe('MedusaAdapter.listProducts', () => {
  it('maps products to ProductItem shape with HUF price', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/products': { body: PRODUCTS_PAGE_FIXTURE } }),
    )
    const products = await adapter.listProducts()
    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({
      externalId: 'prod_1',
      sku: 'SKU-001',
      name: 'Termék 1',
      priceGross: 12700,
      stock: 10,
    })
  })

  it('picks HUF price when EUR price is also present', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/products': { body: PRODUCTS_PAGE_FIXTURE } }),
    )
    const products = await adapter.listProducts()
    // prod_2 has both EUR and HUF price — must pick HUF
    expect(products[1].priceGross).toBe(11900)
  })

  it('skips products with no HUF price', async () => {
    const noHufFixture = {
      products: [
        {
          id: 'prod_no_huf',
          title: 'Euro termék',
          variants: [
            {
              id: 'var_x',
              sku: 'EUR-001',
              prices: [{ id: 'pe', currency_code: 'eur', amount: 50 }],
              inventory_quantity: 3,
            },
          ],
        },
      ],
      count: 1,
      limit: 50,
      offset: 0,
    }
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/products': { body: noHufFixture } }),
    )
    const products = await adapter.listProducts()
    expect(products).toHaveLength(0)
  })

  it('skips products with no variants', async () => {
    const noVariantFixture = {
      products: [{ id: 'prod_nv', title: 'Variáns nélkül', variants: [] }],
      count: 1,
      limit: 50,
      offset: 0,
    }
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/products': { body: noVariantFixture } }),
    )
    const products = await adapter.listProducts()
    expect(products).toHaveLength(0)
  })

  it('stops paginating when a page is smaller than the limit', async () => {
    // A single-page response with count=2 and products.length=2 < limit=50 → stops after first request.
    let fetchCount = 0
    const countingFetch: FetchFn = async () => {
      fetchCount++
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(PRODUCTS_PAGE_FIXTURE),
        json: async () => PRODUCTS_PAGE_FIXTURE,
      }
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, countingFetch)
    await adapter.listProducts()
    expect(fetchCount).toBe(1) // only one page fetched
  })
})

// ── 3. pushProduct ────────────────────────────────────────────────────────────

describe('MedusaAdapter.pushProduct', () => {
  it('creates a new product when SKU is not found', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = []
    const captureFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ url, method, body })
      if (url.includes('/admin/products') && method === 'GET') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({ products: [] }) }
      }
      if (url.includes('/admin/products') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({ product: { id: 'prod_new_1' } }),
        }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, captureFetch)
    const result = await adapter.pushProduct({
      externalId: '',
      sku: 'NEW-001',
      name: 'Új termék',
      priceGross: 9900,
      stock: 5,
    })

    expect(result.externalId).toBe('prod_new_1')
    const createCall = calls.find((c) => c.method === 'POST' && c.url.includes('/admin/products'))
    expect(createCall?.body).toMatchObject({
      title: 'Új termék',
      status: 'published',
      variants: expect.arrayContaining([
        expect.objectContaining({
          sku: 'NEW-001',
          prices: [{ currency_code: 'huf', amount: 9900 }],
        }),
      ]),
    })
  })

  it('updates the existing variant when SKU already exists', async () => {
    const calls: { url: string; method: string }[] = []
    const updateFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method })
      if (url.includes('/admin/products') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            products: [
              {
                id: 'prod_existing',
                variants: [{ id: 'var_existing', sku: 'SKU-EXIST' }],
              },
            ],
          }),
        }
      }
      if (url.includes('variants/var_existing') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({ variant: {} }) }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, updateFetch)
    const result = await adapter.pushProduct({
      externalId: '',
      sku: 'SKU-EXIST',
      name: 'Létező termék',
      priceGross: 7000,
      stock: 2,
    })

    expect(result.externalId).toBe('prod_existing')
    // Must have called the variant update endpoint, not a product create
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('variants/var_existing'))).toBe(true)
    expect(calls.every((c) => !(c.method === 'POST' && c.url.endsWith('/admin/products')))).toBe(true)
  })
})

// ── 4. updatePriceStock ───────────────────────────────────────────────────────

describe('MedusaAdapter.updatePriceStock', () => {
  it('sends price update and inventory level update', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = []
    const updateFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ url, method, body })

      if (url.includes('/admin/products/prod_1') && !url.includes('/variants/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            product: {
              id: 'prod_1',
              variants: [
                { id: 'var_1', prices: [{ id: 'price_1', currency_code: 'huf', amount: 12700 }] },
              ],
            },
          }),
        }
      }
      if (url.includes('variants/var_1') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({ variant: {} }) }
      }
      if (url.includes('/admin/inventory-items') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            inventory_items: [
              {
                id: 'inv_1',
                location_levels: [
                  { id: 'level_1', location_id: 'loc_1', stocked_quantity: 10 },
                ],
              },
            ],
          }),
        }
      }
      if (url.includes('location-levels/loc_1') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
      }
      return {
        ok: false,
        status: 404,
        text: async () => `no fixture: ${method} ${url}`,
        json: async () => ({}),
      }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, updateFetch)
    await expect(adapter.updatePriceStock('prod_1', 15000, 20)).resolves.toBeUndefined()

    // Price update used the existing price id
    const variantUpdate = calls.find(
      (c) => c.url.includes('variants/var_1') && c.method === 'POST',
    )
    expect(variantUpdate?.body).toMatchObject({ prices: [{ id: 'price_1', amount: 15000 }] })

    // Stock update sent correct stocked_quantity
    const stockUpdate = calls.find(
      (c) => c.url.includes('location-levels/loc_1') && c.method === 'POST',
    )
    expect(stockUpdate?.body).toMatchObject({ stocked_quantity: 20 })
  })

  it('adds a new HUF price when none exists yet', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = []
    const addPriceFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ url, method, body })
      if (url.includes('/admin/products/prod_2') && !url.includes('/variants/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            product: {
              id: 'prod_2',
              variants: [{ id: 'var_2', prices: [] }],
            },
          }),
        }
      }
      if (url.includes('variants/var_2') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
      }
      if (url.includes('/admin/inventory-items') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({ inventory_items: [] }),
        }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, addPriceFetch)
    await expect(adapter.updatePriceStock('prod_2', 8900, 3)).resolves.toBeUndefined()

    const variantUpdate = calls.find(
      (c) => c.url.includes('variants/var_2') && c.method === 'POST',
    )
    expect(variantUpdate?.body).toMatchObject({
      prices: [{ currency_code: 'huf', amount: 8900 }],
    })
  })

  it('skips inventory update gracefully when no inventory item is found', async () => {
    const noInvFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/admin/products/prod_x') && !url.includes('/variants/') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({
            product: {
              id: 'prod_x',
              variants: [
                { id: 'var_x', prices: [{ id: 'px_1', currency_code: 'huf', amount: 5000 }] },
              ],
            },
          }),
        }
      }
      if (url.includes('variants/var_x') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
      }
      if (url.includes('/admin/inventory-items') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({ inventory_items: [] }),
        }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, noInvFetch)
    await expect(adapter.updatePriceStock('prod_x', 6000, 10)).resolves.toBeUndefined()
  })

  it('throws when the product has no variants', async () => {
    const noVariantFetch: FetchFn = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({ product: { id: 'prod_nv', variants: [] } }),
        }
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, noVariantFetch)
    await expect(adapter.updatePriceStock('prod_nv', 5000, 1)).rejects.toThrow()
  })
})

// ── 5. listOrders / fetchOrders ───────────────────────────────────────────────

describe('MedusaAdapter.listOrders', () => {
  it('maps Medusa orders to OrderItem shape', async () => {
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/orders': { body: ORDERS_FIXTURE } }),
    )
    const orders = await adapter.listOrders()
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      externalId: 'order_1',
      status: 'pending',
      customerName: 'Teszt Ügyfél',
      createdAt: '2026-11-01T10:00:00Z',
      items: [{ sku: 'SKU-001', qty: 2, priceGross: 12700 }],
    })
  })

  it('falls back to Ismeretlen when customer is missing', async () => {
    const noCustomerFixture = {
      orders: [
        {
          id: 'order_nc',
          status: 'pending',
          customer: undefined,
          created_at: '2026-11-01T10:00:00Z',
          items: [],
        },
      ],
    }
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/orders': { body: noCustomerFixture } }),
    )
    const orders = await adapter.listOrders()
    expect(orders[0].customerName).toBe('Ismeretlen')
  })

  it('uses item.id as SKU fallback when variant.sku is null', async () => {
    const noSkuFixture = {
      orders: [
        {
          id: 'order_ns',
          status: 'pending',
          customer: { first_name: 'A', last_name: 'B' },
          created_at: '2026-11-02T10:00:00Z',
          items: [{ id: 'item_fallback', variant: { sku: null }, quantity: 1, unit_price: 5000 }],
        },
      ],
    }
    const adapter = new MedusaAdapter(
      { domain: DOMAIN },
      { apiKey: API_KEY },
      makeMockFetch({ '/admin/orders': { body: noSkuFixture } }),
    )
    const orders = await adapter.listOrders()
    expect(orders[0].items[0].sku).toBe('item_fallback')
  })
})

describe('MedusaAdapter.fetchOrders', () => {
  it('passes created_at[$gt] filter in the URL', async () => {
    let capturedUrl = ''
    const captureFetch: FetchFn = async (url) => {
      capturedUrl = url
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ orders: [] }),
      }
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, captureFetch)
    const since = new Date('2026-11-01T00:00:00.000Z')
    await adapter.fetchOrders(since)
    expect(capturedUrl).toContain('created_at')
    expect(capturedUrl).toContain('2026-11-01')
  })

  it('returns only orders after the since date (via URL filter)', async () => {
    // The filtering is server-side; adapter passes the date — verify URL contains the encoded date.
    let capturedUrl = ''
    const captureFetch: FetchFn = async (url) => {
      capturedUrl = url
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ orders: [] }) }
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, captureFetch)
    await adapter.fetchOrders(new Date('2026-10-15T12:00:00.000Z'))
    expect(capturedUrl).toContain('2026-10-15')
  })
})

// ── 6. Auth header ────────────────────────────────────────────────────────────

describe('MedusaAdapter auth header', () => {
  it('sends Authorization: Basic with base64-encoded colon-prefixed key', async () => {
    let capturedAuth = ''
    const captureFetch: FetchFn = async (url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? ''
      if (url.includes('/admin/stores')) {
        return { ok: true, status: 200, text: async () => '{}', json: async () => STORE_FIXTURE }
      }
      // /admin/products for the product count in testConnection
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ products: [], count: 0 }),
      }
    }

    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, captureFetch)
    await adapter.testConnection()

    expect(capturedAuth).toMatch(/^Basic /)
    // Decode and verify: base64(":" + apiKey) → ":sk_test_abcdef123456"
    const decoded = Buffer.from(capturedAuth.replace('Basic ', ''), 'base64').toString('utf-8')
    expect(decoded).toBe(`:${API_KEY}`)
  })

  it('includes the Authorization header on every request', async () => {
    const authValues: string[] = []
    const captureFetch: FetchFn = async (url, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? ''
      if (auth) authValues.push(auth)
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ orders: [] }) }
    }
    const adapter = new MedusaAdapter({ domain: DOMAIN }, { apiKey: API_KEY }, captureFetch)
    await adapter.listOrders()
    expect(authValues.length).toBeGreaterThan(0)
    expect(authValues.every((v) => v.startsWith('Basic '))).toBe(true)
  })
})

// ── 7. Constructor validation ─────────────────────────────────────────────────

describe('MedusaAdapter constructor', () => {
  it('throws when domain is missing from config', () => {
    expect(() => new MedusaAdapter({}, { apiKey: 'key' })).toThrow(/domain/)
  })

  it('throws when domain is an empty string', () => {
    expect(() => new MedusaAdapter({ domain: '' }, { apiKey: 'key' })).toThrow()
  })

  it('rejects localhost', () => {
    expect(() => new MedusaAdapter({ domain: 'localhost' }, { apiKey: 'key' }))
      .toThrow(/érvénytelen domain/i)
  })

  it('rejects 127.0.0.1 (loopback IP)', () => {
    expect(() => new MedusaAdapter({ domain: '127.0.0.1' }, { apiKey: 'key' }))
      .toThrow(/érvénytelen domain/i)
  })

  it('rejects 169.254.169.254 (link-local / IMDS IP)', () => {
    expect(() => new MedusaAdapter({ domain: '169.254.169.254' }, { apiKey: 'key' }))
      .toThrow(/érvénytelen domain/i)
  })

  it('rejects single-label hosts (no dot)', () => {
    expect(() => new MedusaAdapter({ domain: 'intranet' }, { apiKey: 'key' }))
      .toThrow(/érvénytelen domain/i)
  })

  it('accepts a valid FQDN', () => {
    expect(() => new MedusaAdapter({ domain: 'admin.myshop.hu' }, { apiKey: 'key' })).not.toThrow()
  })
})
