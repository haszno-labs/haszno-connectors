import { XMLParser } from 'fast-xml-parser'

export type FeedProduct = {
  sku: string
  name: string
  costNet: number
  stock: number
  rrpGross: number | null
}

export type MarketPrice = { sku: string; marketMinGross: number; marketShop: string | null }

const toInt = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n) : null
}

/** Minimal CSV parser: `,` or `;` delimiter, double-quoted fields, header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return []
  const delim = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const split = (line: string) => {
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') q = false
        else cur += c
      } else if (c === '"') q = true
      else if (c === delim) { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }
  const header = split(lines[0]).map((h) => h.toLowerCase())
  return lines.slice(1).map((l) => {
    const cells = split(l)
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
  })
}

function rowToProduct(r: Record<string, unknown>, line: number): FeedProduct {
  const sku = String(r.sku ?? '').trim()
  const name = String(r.name ?? '').trim()
  const costNet = toInt(r.cost_net)
  if (!sku || !name || costNet == null) {
    throw new Error(`${line}. sor: kötelező mező hiányzik (sku, name, cost_net)`)
  }
  return { sku, name, costNet, stock: toInt(r.stock) ?? 0, rrpGross: toInt(r.rrp_gross) }
}

/**
 * Supplier feed → products. CSV columns: sku, name, cost_net, stock, rrp_gross.
 * XML: <products><product><sku/><name/><cost_net/><stock/><rrp_gross/></product></products>
 */
export function parseSupplierFeed(content: string, format: 'csv' | 'xml'): FeedProduct[] {
  if (format === 'csv') return parseCsv(content).map((r, i) => rowToProduct(r, i + 2))
  const doc = new XMLParser({ parseTagValue: false }).parse(content)
  const items = doc?.products?.product
  const list = Array.isArray(items) ? items : items ? [items] : []
  return list.map((r: Record<string, unknown>, i: number) => rowToProduct(r, i + 1))
}

/** Market price CSV: sku, market_min_gross, shop (optional). */
export function parseMarketPrices(content: string): MarketPrice[] {
  return parseCsv(content).map((r, i) => {
    const marketMinGross = toInt(r.market_min_gross)
    if (!r.sku || marketMinGross == null) throw new Error(`${i + 2}. sor: sku és market_min_gross kötelező`)
    return { sku: r.sku, marketMinGross, marketShop: r.shop || null }
  })
}
