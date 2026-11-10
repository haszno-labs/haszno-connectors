/**
 * Pure connector unit tests (no database required).
 *
 * Tests:
 * 1. MockAdapter returns deterministic products / orders (no real HTTP).
 * 2. createAdapter falls back to MockAdapter when env credentials are absent.
 *
 * NOTE: DB-dependent tests (CRUD endpoints, sync runs, credential encryption) from
 * the original connectors.test.ts were dropped because they require a running
 * Postgres instance and the Hono app. Those live in the private backend repo.
 */
import { describe, expect, it } from 'vitest'
import { createAdapter, MockAdapter, ShoprenterAdapter } from '../src/connectors/platform.js'
import { UnasAdapterStub } from '../src/connectors/adapters/unas.js'

// ============================================================
//  1. MockAdapter — unit tests (no DB, no HTTP)
// ============================================================

describe('MockAdapter', () => {
  const mock = new MockAdapter()

  it('listProducts returns deterministic non-empty list', async () => {
    const products = await mock.listProducts()
    expect(products.length).toBeGreaterThan(0)
    expect(products[0]).toMatchObject({
      externalId: expect.any(String),
      sku: expect.any(String),
      name: expect.any(String),
      priceGross: expect.any(Number),
      stock: expect.any(Number),
    })
    // Deterministic: same result on second call
    const products2 = await mock.listProducts()
    expect(products).toEqual(products2)
  })

  it('updatePriceStock is a no-op (does not throw)', async () => {
    await expect(mock.updatePriceStock('MOCK-SKU-001', 9900, 5)).resolves.toBeUndefined()
  })

  it('listOrders returns deterministic list', async () => {
    const orders = await mock.listOrders()
    expect(orders.length).toBeGreaterThan(0)
    expect(orders[0]).toMatchObject({ externalId: expect.any(String), status: expect.any(String) })
    const orders2 = await mock.listOrders()
    expect(orders).toEqual(orders2)
  })
})

// ============================================================
//  2. createAdapter falls back to mock when env creds absent
// ============================================================

describe('createAdapter', () => {
  it('returns MockAdapter for shoprenter without env creds', () => {
    const adapter = createAdapter('shoprenter', { shopName: 'mybolt' })
    expect(adapter).toBeInstanceOf(MockAdapter)
  })

  it('returns MockAdapter for unas without env creds', () => {
    const adapter = createAdapter('unas', {})
    expect(adapter).toBeInstanceOf(MockAdapter)
  })

  it('returns MockAdapter for mock platform', () => {
    const adapter = createAdapter('mock', {})
    expect(adapter).toBeInstanceOf(MockAdapter)
  })

  // UNAS must use the fully-implemented UnasAdapterStub, not a stub
  it('returns UnasAdapterStub for unas with credentials', () => {
    const adapter = createAdapter('unas', {}, { apiKey: 'test-key-123' })
    expect(adapter).toBeInstanceOf(UnasAdapterStub)
  })

  // Shoprenter shopName falls back to credentials.apiUser when config.shopName is absent
  it('creates ShoprenterAdapter using credentials.apiUser as shopName when config.shopName is missing', () => {
    const adapter = createAdapter('shoprenter', {}, { apiUser: 'mybolt', apiKey: 'secret' })
    expect(adapter).toBeInstanceOf(ShoprenterAdapter)
  })

  // Shoprenter still falls back to mock when apiUser is invalid (not a valid subdomain)
  it('falls back to MockAdapter for shoprenter when apiUser is not a valid subdomain', () => {
    const adapter = createAdapter('shoprenter', {}, { apiUser: 'my bolt!', apiKey: 'secret' })
    expect(adapter).toBeInstanceOf(MockAdapter)
  })
})
