# Haszno Agent API — Referencia

A Haszno egy magyar SaaS dropshipping árazás-automatizáló. Ez a dokumentum az AI ügynökök
(Claude Code, Codex, Cursor stb.) számára írja le az összes HTTP végpontot, amelyeken keresztül
az ügynök lekérheti a partnerkatekógust, termékeket és árakat, kezelhet árajánlatokat,
futtathat szabályokat, és figyelemmel kísérheti a rendeléseket.

**Alap URL:** `HASZNO_API_URL` környezeti változóból (alapértelmezett: `https://arfutar-demo.vercel.app`)  
**Hitelesítés:** `Authorization: Bearer <HASZNO_API_KEY>` fejléc; fallback: `HASZNO_BASIC="user:pass"` → HTTP Basic  
**Pénznemek:** minden ár egész forint (bruttó vagy nettó, az endpoint leírásában jelölve)

> **Fontos:** A network/supplier-view végpont kizárólag összesített, tájékoztató jellegű
> piaci áradatokat ad vissza. A beszállító CSAK LÁTHATJA a viszonteladói árakat;
> kötelező viszonteladási ár előírása jogszabályba ütközne (Tpvt. 11. §).

---

## English endpoint reference

All requests and responses are JSON (unless noted). Error responses: `{ "error": "Hungarian message" }`.

---

### Health

#### `GET /api/health`

Returns `{ "ok": true }` if the server is running.

---

### Settings (Pricing rules)

Singleton row (id = 1); controls the automated pricing engine.

#### `GET /api/settings`

Returns the current pricing rules.

**Response:**
```json
{
  "id": 1,
  "undercutPct": 1,
  "minMarginPct": 10,
  "vatPct": 27,
  "automationPaused": false
}
```

Fields:
- `undercutPct` – how much % to undercut the market minimum (0–50)
- `minMarginPct` – minimum net margin the system maintains (0–90)
- `vatPct` – VAT rate used in all margin/price calculations (0–50)
- `automationPaused` – kill switch: when `true`, no rule runs and no proposal can be approved

#### `PUT /api/settings`

Updates pricing rules. **Write operation.**

**Request body:**
```json
{ "undercutPct": 1, "minMarginPct": 10, "vatPct": 27 }
```

---

### Products

All money values are whole forints. `costNet` is VAT-exclusive; `priceGross`, `rrpGross`, `marketMinGross` are gross.

#### `GET /api/products[?all=1]`

Returns listed products (or all with `?all=1`), each enriched with:
- `supplierName` – supplier's name
- `current` – live margin for the current price
- `recommended` – the system's recommended price and margin

**Response item:**
```json
{
  "id": 1,
  "supplierId": 1,
  "sku": "ABC-123",
  "name": "Párásító deluxe",
  "costNet": 3500,
  "stock": 10,
  "rrpGross": 9990,
  "marketMinGross": 8500,
  "marketShop": "example.hu",
  "priceGross": 8900,
  "listed": true,
  "trendKeyword": "párásító",
  "trendKeywordEn": "humidifier",
  "updatedAt": "2024-01-01T00:00:00Z",
  "supplierName": "Demo Supplier",
  "current": { "priceGross": 8900, "marginNet": 1500, "marginPct": 19.0 },
  "recommended": { "priceGross": 8500, "marginNet": 1200, "marginPct": 16.1 }
}
```

#### `PATCH /api/products/:id`

Updates market data or manually sets price. **Write operation.**

**Request body** (all fields optional):
```json
{
  "marketMinGross": 8500,
  "marketShop": "example.hu",
  "priceGross": 8900
}
```

#### `POST /api/products/:id/listing`

Lists or unlists a product. Listing sets the price to `recommended.priceGross`. **Write operation.**

**Request body:**
```json
{ "listed": true }
```

#### `POST /api/products/:id/ai-description`

Generates a Hungarian marketing description via Claude AI. **Write operation (AI call).**

**Response:**
```json
{ "text": "Hungarian product description..." }
```

#### `POST /api/products/apply-prices`

Applies the recommended price to every listed product (or to the given ids). **Write operation.**

**Request body** (optional):
```json
{ "ids": [1, 2, 3] }
```

If `ids` is omitted → applies to all listed products. If `ids: []` → no-op.

**Response:**
```json
{ "changed": 5, "total": 10 }
```

---

### Impact (Haszon-mérő)

#### `GET /api/impact[?days=30]`

Returns the extra profit attributable to Haszno's automated pricing over the last N days (1–365, default 30).

**Response:**
```json
{
  "days": 30,
  "extraProfit": 45000,
  "baseline": 180000,
  "pctGain": 25.0,
  "orders": 12,
  "autoForwardedOrders": 10
}
```

---

### Suppliers

#### `GET /api/suppliers`

Lists all suppliers (own + network).

**Response item:**
```json
{
  "id": 1,
  "name": "Demo Supplier",
  "orderMode": "simulated",
  "email": null,
  "network": false,
  "category": null,
  "country": null,
  "shopUrl": null,
  "createdAt": "2024-01-01T00:00:00Z"
}
```

---

### Feeds — Import

#### `POST /api/feeds/import`

Imports a supplier product feed (CSV or XML). **Write operation.**

**Request body:**
```json
{
  "supplierId": 1,
  "format": "csv",
  "content": "sku,name,costNet,stock,rrpGross\nABC-1,Termék,3500,10,9990"
}
```

**Response:**
```json
{ "created": 5, "updated": 3, "total": 8 }
```

#### `POST /api/market-prices/import`

Imports market comparison prices (CSV). **Write operation.**

**Request body:**
```json
{ "content": "sku,marketMinGross,marketShop\nABC-1,8500,example.hu" }
```

**Response:**
```json
{ "matched": 3, "total": 5 }
```

---

### Feeds — Export

#### `GET /feed/arukereso.xml`

Returns an Árukereső-compatible product XML feed for all listed products.

#### `GET /feed/google.xml`

Returns a Google Merchant Center-compatible product XML feed for all listed products.

---

### Orders

#### `GET /api/orders`

Returns the last 50 orders with their line items.

**Response item:**
```json
{
  "id": 1,
  "externalId": "WEB-123456",
  "customerName": "Kovács Anna",
  "address": "1234 Budapest, Fő u. 1.",
  "status": "forwarded",
  "supplierOrderId": null,
  "trackingNumber": null,
  "totalGross": 17800,
  "events": [{"at": "2024-01-01T00:00:00Z", "text": "Rendelés megérkezett"}],
  "createdAt": "2024-01-01T00:00:00Z",
  "items": [
    { "orderId": 1, "qty": 2, "priceGross": 8900, "name": "Párásító deluxe", "sku": "ABC-1" }
  ]
}
```

Order statuses: `received` → `forwarded` → `shipped`, or `error`.

#### `POST /api/webhooks/order`

Receives a new order from the shop. **Write operation.**

**Request body:**
```json
{
  "externalId": "WEB-123456",
  "customerName": "Kovács Anna",
  "address": "9200 Mosonmagyaróvár, Fő u. 1.",
  "items": [
    { "sku": "ABC-1", "qty": 2 }
  ]
}
```

**Response:** `{ "id": 42 }` (201 Created)

#### `POST /api/demo/order`

Creates a random demo order from in-stock products. **Write operation (demo only).**

#### `POST /api/orders/:id/ship`

Marks an order as shipped. **Write operation.**

---

### Stats

#### `GET /api/stats`

Returns dashboard summary numbers for listed products.

**Response:**
```json
{
  "products": 25,
  "losing": 2,
  "overMarket": 3,
  "toFix": 5,
  "orders": 42
}
```

Fields:
- `products` – number of listed products
- `losing` – products with negative net margin
- `overMarket` – products priced above the market minimum
- `toFix` – products where current price differs from recommended
- `orders` – total order count

---

### Recommendations (Termékötletek)

#### `GET /api/recommendations`

Returns the AI-curated product idea shortlist from the full catalogue (trending + margin-safe).

**Response:**
```json
{
  "anchor": "páramentesítő",
  "geo": "HU",
  "items": [
    {
      "id": 5,
      "sku": "XYZ-99",
      "name": "Páramentesítő 2000ml",
      "costNet": 4500,
      "stock": 20,
      "supplierName": "Demo Supplier",
      "recommended": { "priceGross": 10990, "marginNet": 2000, "marginPct": 22.5 },
      "trendScore": 85.3
    }
  ]
}
```

---

### Trends (keyword fill)

#### `POST /api/trends/keywords`

Fills missing trend keywords for products that have none. Uses Claude AI. **Write operation (AI call).**

**Response:**
```json
{ "updated": 12 }
```

---

### Rules (Automatikák)

#### `GET /api/rules/templates`

Returns the built-in rule templates.

**Response item:**
```json
{
  "key": "keszlet_or",
  "name": "Készlet-őr",
  "description": "...",
  "trigger": "feed_import",
  "conditions": [{ "field": "stock", "op": "eq", "value": 0 }],
  "actions": [{ "type": "unlist" }]
}
```

#### `GET /api/rules`

Lists all configured rules.

**Response item:**
```json
{
  "id": 1,
  "name": "Készlet-őr",
  "enabled": true,
  "trigger": "feed_import",
  "conditions": [...],
  "actions": [...],
  "template": "keszlet_or",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

#### `POST /api/rules`

Creates a new rule. **Write operation.**

**Request body:**
```json
{
  "name": "Készlet-őr",
  "enabled": true,
  "trigger": "feed_import",
  "conditions": [{ "field": "stock", "op": "eq", "value": 0 }],
  "actions": [{ "type": "unlist" }],
  "template": "keszlet_or"
}
```

Condition `op` values: `lt`, `lte`, `gt`, `gte`, `eq`, `neq`, `changed`  
Action `type` values: `unlist`, `propose_price`, `notify`

#### `PATCH /api/rules/:id`

Updates a rule. **Write operation.**

#### `DELETE /api/rules/:id`

Deletes a rule and its run log. **Write operation.**

#### `POST /api/rules/:id/run`

Manually runs a single rule against all products. **Write operation.**

**Response:**
```json
{ "applied": 3, "skipped": 7, "errors": 0 }
```

#### `POST /api/rules/run-all`

Runs all enabled manual-trigger rules. **Write operation.**

#### `POST /api/rules/trigger`

Fires a named trigger (for external/webhook callers). **Write operation.**

**Request body:**
```json
{ "trigger": "market_price", "productIds": [1, 2, 3] }
```

#### `GET /api/rule-runs[?limit=30]`

Returns the rule execution log (default 30, max 200 entries).

**Response item:**
```json
{
  "id": 1,
  "ruleId": 1,
  "ruleName": "Készlet-őr",
  "trigger": "feed_import",
  "productId": 5,
  "summary": "Termék levéve: ABC-1",
  "at": "2024-01-01T00:00:00Z"
}
```

---

### Proposals (Árajánlatok)

#### `GET /api/proposals[?status=pending]`

Returns price proposals filtered by status (`pending`, `approved`, `rejected`, `rolled_back`).

**Response item:**
```json
{
  "id": 1,
  "productId": 5,
  "productName": "Párásító deluxe",
  "productSku": "ABC-1",
  "oldPriceGross": 8900,
  "proposedPriceGross": 8500,
  "reason": "Piaci ár alatti pozicionálás",
  "source": "rule:1",
  "status": "pending",
  "batchId": null,
  "createdAt": "2024-01-01T00:00:00Z",
  "decidedAt": null
}
```

#### `POST /api/proposals/approve`

Approves proposals (all pending, or selected ids). **Write operation.**

**Request body** (optional):
```json
{ "ids": [1, 2, 3] }
```

**Response:**
```json
{ "batchId": "b-1704067200000-abc123", "applied": 3 }
```

Returns 409 if `automationPaused = true`.

#### `POST /api/proposals/reject`

Rejects the given proposals. **Write operation.**

**Request body:**
```json
{ "ids": [1, 2, 3] }
```

**Response:**
```json
{ "rejected": 3 }
```

#### `POST /api/proposals/rollback`

Rolls back an approved batch to the previous prices. **Write operation.**

**Request body:**
```json
{ "batchId": "b-1704067200000-abc123" }
```

**Response:**
```json
{ "rolledBack": 3 }
```

---

### Automation kill switch

#### `GET /api/automation`

Returns whether the automation kill switch is active.

**Response:**
```json
{ "paused": false }
```

#### `PUT /api/automation`

Enables or disables the automation kill switch. **Write operation.**

**Request body:**
```json
{ "paused": true }
```

---

### Network (Beszállítói hálózat)

#### `GET /api/network/suppliers`

Lists network suppliers with connection status, product count, and average reseller margin.

**Response item:**
```json
{
  "id": 2,
  "name": "Partner Kft.",
  "network": true,
  "category": "electronics",
  "country": "HU",
  "shopUrl": "https://partner.hu",
  "connected": true,
  "productCount": 42,
  "avgResellerMarginPct": 18.5
}
```

#### `GET /api/network/suppliers/:id/products`

Returns the full catalogue for a network supplier including potential margin estimates.

**Response item:**
```json
{
  "id": 1,
  "supplierId": 2,
  "sku": "NP-001",
  "name": "Widget Pro",
  "ean": "1234567890123",
  "category": "electronics",
  "wholesaleNet": 5000,
  "rrpGross": 15990,
  "stock": 100,
  "updatedAt": "2024-01-01T00:00:00Z",
  "potentialMargin": { "priceGross": 11990, "marginNet": 2500, "marginPct": 24.0 }
}
```

#### `POST /api/network/suppliers/:id/connect`

Connects to a network supplier and imports their catalogue as unlisted products. Idempotent. **Write operation.**

**Response:**
```json
{ "status": "connected", "imported": 40, "skipped": 2 }
```

#### `POST /api/network/suppliers/:id/disconnect`

Disconnects from a network supplier and unlists all their imported products. **Write operation.**

**Response:**
```json
{ "status": "disconnected" }
```

#### `POST /api/network/suppliers/:id/sync`

Refreshes cost and stock for all imported products from the live network catalogue. **Write operation.**

**Response:**
```json
{ "costChanges": 3, "stockOuts": 1, "total": 42 }
```

#### `GET /api/network/supplier-view/:supplierId`

Returns aggregated reseller price statistics per product for the supplier view.
**Read-only. Legal note: informational market observation data only.**

**Response:**
```json
{
  "supplier": { "id": 2, "name": "Partner Kft.", "category": "electronics", "country": "HU", "shopUrl": "https://partner.hu" },
  "products": [
    {
      "id": 1,
      "sku": "NP-001",
      "name": "Widget Pro",
      "wholesaleNet": 5000,
      "rrpGross": 15990,
      "resellerCount": 8,
      "minGross": 10990,
      "avgGross": 12500,
      "maxGross": 15490,
      "belowRrp": 6,
      "lossCount": 0,
      "saturation": 8
    }
  ]
}
```
