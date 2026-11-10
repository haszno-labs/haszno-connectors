/**
 * UNAS adapter unit tests — no real network.
 *
 * All HTTP calls are intercepted via an injected FetchFn so this suite runs
 * fully offline and does not touch any database.
 *
 * Tests:
 *  1. getToken: sends POST with Action: getToken and parses token from response.
 *  2. getToken: caches token (called only once for multiple API calls).
 *  3. getToken: throws on non-200 response.
 *  4. getToken: throws when response contains no <Token>.
 *  5. listProducts: parses product XML into ProductItem[].
 *  6. listProducts: returns empty array for empty response.
 *  7. listProducts: sends getProduct action with StatusBase filter.
 *  8. pushProduct: sends setProduct with sku/name/price/stock, returns externalId.
 *  9. updatePriceStock: sends setProduct with sku/price/stock only.
 * 10. listOrders: parses order XML including nested OrderProduct items.
 * 11. fetchOrders: filters orders by since date.
 * 12. listOrders: sends getOrder action with Limit.
 * 13. testConnection: returns ok:true with productCount on success.
 * 14. testConnection: returns ok:false with error on HTTP failure.
 * 15. testConnection: never throws even on network error.
 * 16. XML escaping: special chars in SKU/name are escaped in pushProduct.
 * 17. XML escaping: special chars in SKU are escaped in updatePriceStock.
 * 18. XML escaping: apiKey is escaped in getToken request.
 */
import { describe, expect, it } from 'vitest'
import type { FetchFn } from '../src/net/fetcher.js'
import { UnasAdapterStub } from '../src/connectors/adapters/unas.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_RESPONSE = '<Response><Token>test-token-abc</Token></Response>'

const PRODUCTS_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<Products>
  <Product>
    <Sku>SKU-001</Sku>
    <Name>Teszt termék</Name>
    <PriceSale>12700</PriceSale>
    <Stock>15</Stock>
  </Product>
  <Product>
    <Sku>SKU-002</Sku>
    <Name>Másik termék</Name>
    <PriceSale>5000.5</PriceSale>
    <Stock>0</Stock>
  </Product>
</Products>`

const ORDERS_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<Orders>
  <Order>
    <Id>ORD-100</Id>
    <Status>feldolgozás alatt</Status>
    <CustomerName>Kovács János</CustomerName>
    <Date>2026-11-01T10:00:00Z</Date>
    <OrderProduct>
      <Sku>SKU-001</Sku>
      <Quantity>2</Quantity>
      <PriceSale>12700</PriceSale>
    </OrderProduct>
  </Order>
  <Order>
    <Id>ORD-101</Id>
    <Status>teljesítve</Status>
    <CustomerName>Nagy Éva</CustomerName>
    <Date>2026-11-05T08:00:00Z</Date>
    <OrderProduct>
      <Sku>SKU-002</Sku>
      <Quantity>1</Quantity>
      <PriceSale>5000</PriceSale>
    </OrderProduct>
  </Order>
</Orders>`

const SET_OK_RESPONSE = '<Response><Status>ok</Status></Response>'

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockResponse = { status?: number; body: string }

/**
 * Build a FetchFn that consumes responses sequentially from the given list.
 * The last entry is reused if the caller makes more requests than entries provided.
 */
function makeFetch(...responses: MockResponse[]): FetchFn {
  let idx = 0
  return async () => {
    const r = responses[Math.min(idx++, responses.length - 1)]
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text:  async () => r.body,
      json:  async () => { throw new Error('UNAS API returns XML, not JSON') },
    }
  }
}

/** Build a FetchFn that routes by the Action header. */
function makeRoutedFetch(routes: Record<string, string | { status: number; body: string }>): FetchFn {
  return async (_url, init) => {
    const action = (init?.headers as Record<string, string> | undefined)?.Action ?? ''
    const entry  = routes[action] ?? routes['*'] ?? { status: 404, body: '' }
    const { status, body } = typeof entry === 'string' ? { status: 200, body: entry } : entry
    return {
      ok:   status >= 200 && status < 300,
      status,
      text:  async () => body,
      json:  async () => { throw new Error('XML only') },
    }
  }
}

function makeAdapter(mockFetch: FetchFn, apiKey = 'test-api-key-xyz'): UnasAdapterStub {
  return new UnasAdapterStub({}, { apiKey }, mockFetch)
}

// ── 1–4. getToken ─────────────────────────────────────────────────────────────

describe('UnasAdapterStub — getToken', () => {
  it('sends POST to UNAS endpoint with Action: getToken and body containing apiKey', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = []
    const mockFetch: FetchFn = async (url, init) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body:    (init?.body as string) ?? '',
      })
      // first call = getToken, second = getProduct
      if (calls.length === 1) return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      return { ok: true, status: 200, text: async () => PRODUCTS_RESPONSE, json: async () => ({}) }
    }
    const adapter = makeAdapter(mockFetch)
    await adapter.listProducts()
    // First call must be the token request
    expect(calls[0].url).toBe('https://api.unas.eu/shop/')
    expect(calls[0].headers.Action).toBe('getToken')
    expect(calls[0].body).toContain('<ApiKey>test-api-key-xyz</ApiKey>')
  })

  it('caches token — only one getToken call for multiple API calls', async () => {
    let tokenCalls = 0
    const mockFetch = makeRoutedFetch({
      getToken:    TOKEN_RESPONSE,
      getProduct:  PRODUCTS_RESPONSE,
    })
    // Count token calls by wrapping
    const countingFetch: FetchFn = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers.Action === 'getToken') tokenCalls++
      return mockFetch(url, init)
    }
    const adapter = makeAdapter(countingFetch)
    await adapter.listProducts()
    await adapter.listProducts()
    expect(tokenCalls).toBe(1)
  })

  it('throws on non-200 token response', async () => {
    const adapter = makeAdapter(makeFetch({ status: 403, body: '<Error>Forbidden</Error>' }))
    await expect(adapter.listProducts()).rejects.toThrow(/hiba/)
  })

  it('throws when response contains no <Token>', async () => {
    const adapter = makeAdapter(makeFetch({ body: '<Response><Error>invalid key</Error></Response>' }))
    await expect(adapter.listProducts()).rejects.toThrow(/token nem érkezett/)
  })
})

// ── 5–7. listProducts ─────────────────────────────────────────────────────────

describe('UnasAdapterStub — listProducts', () => {
  it('parses two products from getProduct XML', async () => {
    const adapter = makeAdapter(makeRoutedFetch({ getToken: TOKEN_RESPONSE, getProduct: PRODUCTS_RESPONSE }))
    const products = await adapter.listProducts()
    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({
      externalId: 'SKU-001',
      sku:        'SKU-001',
      name:       'Teszt termék',
      priceGross: 12700,
      stock:      15,
    })
    // 5000.5 rounds to 5001 (Math.round)
    expect(products[1]).toMatchObject({ sku: 'SKU-002', priceGross: 5001, stock: 0 })
  })

  it('returns empty array for empty product list', async () => {
    const adapter = makeAdapter(makeRoutedFetch({
      getToken:   TOKEN_RESPONSE,
      getProduct: '<?xml version="1.0"?><Products></Products>',
    }))
    expect(await adapter.listProducts()).toEqual([])
  })

  it('sends getProduct action with <StatusBase>1</StatusBase>', async () => {
    const calls: { action: string; body: string }[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const action  = headers.Action ?? ''
      calls.push({ action, body: (init?.body as string) ?? '' })
      if (action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      return { ok: true, status: 200, text: async () => PRODUCTS_RESPONSE, json: async () => ({}) }
    }
    await makeAdapter(mockFetch).listProducts()
    const productCall = calls.find((c) => c.action === 'getProduct')
    expect(productCall).toBeDefined()
    expect(productCall!.body).toContain('<StatusBase>1</StatusBase>')
  })
})

// ── 8. pushProduct ────────────────────────────────────────────────────────────

describe('UnasAdapterStub — pushProduct', () => {
  it('sends setProduct with sku, name, price, stock and returns externalId === sku', async () => {
    const calls: { action: string; body: string }[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ action: headers.Action ?? '', body: (init?.body as string) ?? '' })
      if (headers.Action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      return { ok: true, status: 200, text: async () => SET_OK_RESPONSE, json: async () => ({}) }
    }
    const result = await makeAdapter(mockFetch).pushProduct({
      externalId: 'SKU-003',
      sku:        'SKU-003',
      name:       'Új termék',
      priceGross: 9900,
      stock:      5,
    })
    expect(result).toEqual({ externalId: 'SKU-003' })
    const setCall = calls.find((c) => c.action === 'setProduct')
    expect(setCall).toBeDefined()
    expect(setCall!.body).toContain('<Sku>SKU-003</Sku>')
    expect(setCall!.body).toContain('<Name>Új termék</Name>')
    expect(setCall!.body).toContain('<PriceSale>9900</PriceSale>')
    expect(setCall!.body).toContain('<Stock>5</Stock>')
  })
})

// ── 9. updatePriceStock ───────────────────────────────────────────────────────

describe('UnasAdapterStub — updatePriceStock', () => {
  it('sends setProduct with sku, price, stock (no name field)', async () => {
    const calls: { action: string; body: string }[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ action: headers.Action ?? '', body: (init?.body as string) ?? '' })
      if (headers.Action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      return { ok: true, status: 200, text: async () => SET_OK_RESPONSE, json: async () => ({}) }
    }
    await makeAdapter(mockFetch).updatePriceStock('SKU-001', 11000, 20)
    const setCall = calls.find((c) => c.action === 'setProduct')
    expect(setCall).toBeDefined()
    expect(setCall!.body).toContain('<Sku>SKU-001</Sku>')
    expect(setCall!.body).toContain('<PriceSale>11000</PriceSale>')
    expect(setCall!.body).toContain('<Stock>20</Stock>')
    // updatePriceStock does not include Name
    expect(setCall!.body).not.toContain('<Name>')
  })
})

// ── 10–12. listOrders / fetchOrders ──────────────────────────────────────────

describe('UnasAdapterStub — listOrders / fetchOrders', () => {
  it('parses order list including nested OrderProduct items', async () => {
    const adapter = makeAdapter(makeRoutedFetch({ getToken: TOKEN_RESPONSE, getOrder: ORDERS_RESPONSE }))
    const orders = await adapter.listOrders()
    expect(orders).toHaveLength(2)
    expect(orders[0]).toMatchObject({
      externalId:   'ORD-100',
      status:       'feldolgozás alatt',
      customerName: 'Kovács János',
      createdAt:    '2026-11-01T10:00:00Z',
    })
    expect(orders[0].items).toHaveLength(1)
    expect(orders[0].items[0]).toMatchObject({ sku: 'SKU-001', qty: 2, priceGross: 12700 })
    expect(orders[1].externalId).toBe('ORD-101')
  })

  it('fetchOrders filters by since date (keeps only later orders)', async () => {
    const adapter = makeAdapter(makeRoutedFetch({ getToken: TOKEN_RESPONSE, getOrder: ORDERS_RESPONSE }))
    // ORD-100 = 2026-11-01, ORD-101 = 2026-11-05 → only ORD-101 is at/after 2026-11-04
    const orders = await adapter.fetchOrders(new Date('2026-11-04T00:00:00Z'))
    expect(orders).toHaveLength(1)
    expect(orders[0].externalId).toBe('ORD-101')
  })

  it('fetchOrders returns all orders when since is earlier than all', async () => {
    const adapter = makeAdapter(makeRoutedFetch({ getToken: TOKEN_RESPONSE, getOrder: ORDERS_RESPONSE }))
    const orders = await adapter.fetchOrders(new Date('2026-01-01T00:00:00Z'))
    expect(orders).toHaveLength(2)
  })

  it('sends getOrder action with <Limit>50</Limit>', async () => {
    const calls: { action: string; body: string }[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ action: headers.Action ?? '', body: (init?.body as string) ?? '' })
      if (headers.Action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      return { ok: true, status: 200, text: async () => ORDERS_RESPONSE, json: async () => ({}) }
    }
    await makeAdapter(mockFetch).listOrders()
    const orderCall = calls.find((c) => c.action === 'getOrder')
    expect(orderCall).toBeDefined()
    expect(orderCall!.body).toContain('<Limit>50</Limit>')
  })
})

// ── 13–15. testConnection ─────────────────────────────────────────────────────

describe('UnasAdapterStub — testConnection', () => {
  it('returns ok:true with mode:live and productCount on success', async () => {
    const adapter = makeAdapter(makeRoutedFetch({ getToken: TOKEN_RESPONSE, getProduct: PRODUCTS_RESPONSE }))
    const result = await adapter.testConnection()
    expect(result).toMatchObject({ ok: true, mode: 'live', productCount: 2 })
  })

  it('returns ok:false with error message on HTTP failure', async () => {
    const adapter = makeAdapter(makeFetch({ status: 401, body: '<Error>Unauthorized</Error>' }))
    const result = await adapter.testConnection()
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('live')
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
  })

  it('never throws even when connection fails with a network error', async () => {
    const mockFetch: FetchFn = async () => { throw new Error('ECONNREFUSED') }
    const adapter = makeAdapter(mockFetch)
    await expect(adapter.testConnection()).resolves.toMatchObject({ ok: false, mode: 'live' })
  })
})

// ── 16–18. XML escaping ───────────────────────────────────────────────────────

describe('UnasAdapterStub — XML escaping', () => {
  it('escapes &, <, >, " in product SKU and name for pushProduct', async () => {
    const bodies: string[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers.Action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      bodies.push((init?.body as string) ?? '')
      return { ok: true, status: 200, text: async () => SET_OK_RESPONSE, json: async () => ({}) }
    }
    await makeAdapter(mockFetch).pushProduct({
      externalId: 'x',
      sku:        'SKU-&<>"\'',
      name:       'Termék & Variáns <speciális> "különleges"',
      priceGross: 1000,
      stock:      1,
    })
    expect(bodies[0]).toContain('SKU-&amp;&lt;&gt;&quot;&apos;')
    expect(bodies[0]).toContain('Termék &amp; Variáns &lt;speciális&gt; &quot;különleges&quot;')
  })

  it('escapes special chars in SKU for updatePriceStock', async () => {
    const bodies: string[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers.Action === 'getToken') return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
      bodies.push((init?.body as string) ?? '')
      return { ok: true, status: 200, text: async () => SET_OK_RESPONSE, json: async () => ({}) }
    }
    await makeAdapter(mockFetch).updatePriceStock('SKU&<>', 5000, 10)
    expect(bodies[0]).toContain('SKU&amp;&lt;&gt;')
  })

  it('escapes apiKey in getToken request body', async () => {
    const bodies: string[] = []
    const mockFetch: FetchFn = async (_url, init) => {
      bodies.push((init?.body as string) ?? '')
      return { ok: true, status: 200, text: async () => TOKEN_RESPONSE, json: async () => ({}) }
    }
    // apiKey contains XML special chars
    const adapter = new UnasAdapterStub({}, { apiKey: 'key&with<special>"chars' }, mockFetch)
    await adapter.listProducts().catch(() => {})  // may fail after getToken; that's fine
    expect(bodies[0]).toContain('key&amp;with&lt;special&gt;&quot;chars')
  })
})
