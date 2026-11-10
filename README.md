# @haszno/connectors

> _A Haszno dropshipping platform nyílt forrású összekötő-csomagja._

TypeScript shop-platform adapters (WooCommerce, Shopify, UNAS, Shoprenter, Medusa), a supplier feed parser, and product feed exporters for the [Haszno](https://haszno.hu) dropshipping network.

The hosted service (haszno.hu) handles pricing automation, the supplier catalogue network, and order routing. This package contains only the HTTP adapter layer and feed-parsing utilities — the pricing engine and supplier network are **not** part of this repository.

## Install

The package is not published to npm yet. Use it from a clone:

```bash
git clone https://github.com/haszno-labs/haszno-connectors.git
cd haszno-connectors
npm install && npm run build
```

## Build & Test

```bash
npm run build      # outputs to dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## Usage

### Connector adapter

```typescript
import { createAdapter } from '@haszno/connectors'

// WooCommerce — domain + consumer key/secret
const adapter = createAdapter('woocommerce', { domain: 'mybolt.hu' }, {
  consumerKey: 'ck_xxx',
  consumerSecret: 'cs_xxx',
})

const result = await adapter.testConnection()
// { ok: true, mode: 'live', productCount: 142 }

const products = await adapter.listProducts()
// [{ externalId: '10', sku: 'CHAIR-001', name: 'Irodai szék', priceGross: 12700, stock: 5 }, ...]

await adapter.updatePriceStock('10', 13900, 3)

const orders = await adapter.fetchOrders(new Date('2026-11-01'))
```

Supported platforms: `'woocommerce'`, `'shopify'`, `'unas'`, `'shoprenter'`, `'medusa'`, `'mock'`.

When credentials are absent, `createAdapter` returns a **MockAdapter** (safe default for tests and local development).

### Inject a custom fetch (testing)

All adapters accept an optional `fetchFn` parameter so network calls can be intercepted in tests:

```typescript
import { WooCommerceAdapter } from '@haszno/connectors'
import { vi } from 'vitest'

const mockFetch = vi.fn().mockResolvedValue({
  ok: true, status: 200,
  json: async () => [{ id: 1, sku: 'SKU-001', name: 'Test', price: '9900', regular_price: '9900', stock_quantity: 5, manage_stock: true, in_stock: true }],
  text: async () => '[]',
})

const adapter = new WooCommerceAdapter(
  { domain: 'shop.example.com' },
  { consumerKey: 'ck', consumerSecret: 'cs' },
  mockFetch,
)
```

### Supplier feed parser

```typescript
import { parseSupplierFeed, parseMarketPrices } from '@haszno/connectors'

// Parse a CSV or XML supplier catalogue
const products = parseSupplierFeed(csvText, 'csv')
// [{ sku: 'A1', name: 'Szék', costNet: 10000, stock: 5, rrpGross: 15990 }, ...]

const marketPrices = parseMarketPrices(csvText)
// [{ sku: 'A1', marketMinGross: 12990, marketShop: 'bolt.hu' }, ...]
```

CSV columns: `sku`, `name`, `cost_net`, `stock`, `rrp_gross`. Supports `,` and `;` delimiters with quoted fields.
XML: `<products><product><sku/><name/><cost_net/><stock/><rrp_gross/></product></products>`.

### Product feed exporters

```typescript
import { arukeresoXml, googleXml } from '@haszno/connectors'

const items = [{ sku: 'A1', name: 'Szék', priceGross: 12990, stock: 3 }]

const aruXml = arukeresoXml(items, 'https://mybolt.hu')   // Árukereső-compatible feed
const gXml   = googleXml(items, 'https://mybolt.hu')      // Google Merchant Center RSS
```

### SSRF guard

The `safeFetch` export wraps `fetch` with SSRF protection (private/reserved address blocking), a 5 MB response body cap, and a 15 s timeout. All adapters use it by default.

```typescript
import { safeFetch, makeSafeFetch } from '@haszno/connectors'

// Custom limits
const strictFetch = makeSafeFetch({ maxBytes: 1_000_000, timeoutMs: 5_000 })
```

## Documentation

- [`docs/openapi.yaml`](./docs/openapi.yaml) — Full OpenAPI 3.1 spec for the Haszno REST API
- [`docs/agent-api.md`](./docs/agent-api.md) — Human-readable API reference for AI agents

## About Haszno

Haszno is a Hungarian dropshipping SaaS (haszno.hu) that connects reseller webshops to supplier catalogues, automates market-price-based pricing per shop, and handles order routing. The pricing engine, supplier network, and analytics are not part of this open-source package.
