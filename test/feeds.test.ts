import { describe, expect, it } from 'vitest'
import { arukeresoXml, googleXml } from '../src/feeds/export.js'
import { parseMarketPrices, parseSupplierFeed } from '../src/feeds/parse.js'

describe('supplier feed', () => {
  it('parses CSV with ; delimiter and quoted fields', () => {
    const csv = 'sku;name;cost_net;stock;rrp_gross\nA1;"Szék; fekete";10 000;5;15990\nA2;Asztal;20000;;'
    expect(parseSupplierFeed(csv, 'csv')).toEqual([
      { sku: 'A1', name: 'Szék; fekete', costNet: 10000, stock: 5, rrpGross: 15990 },
      { sku: 'A2', name: 'Asztal', costNet: 20000, stock: 0, rrpGross: null },
    ])
  })

  it('parses XML with one or many products', () => {
    const one = '<products><product><sku>X</sku><name>Lámpa</name><cost_net>5000</cost_net><stock>2</stock></product></products>'
    expect(parseSupplierFeed(one, 'xml')).toEqual([{ sku: 'X', name: 'Lámpa', costNet: 5000, stock: 2, rrpGross: null }])
  })

  it('reports the line of a broken row', () => {
    expect(() => parseSupplierFeed('sku,name,cost_net\nA,,100', 'csv')).toThrow('2. sor')
  })
})

describe('market prices', () => {
  it('parses sku, price and optional shop', () => {
    expect(parseMarketPrices('sku,market_min_gross,shop\nA1,12990,bolt.hu')).toEqual([{ sku: 'A1', marketMinGross: 12990, marketShop: 'bolt.hu' }])
  })
})

describe('export', () => {
  const items = [{ sku: 'A&1', name: 'Szék <új>', priceGross: 12990, stock: 0 }]
  it('escapes XML in the Árukereső feed', () => {
    const x = arukeresoXml(items, 'https://bolt.hu')
    expect(x).toContain('<name>Szék &lt;új&gt;</name>')
    expect(x).toContain('<identifier>A&amp;1</identifier>')
    expect(x).toContain('<availability>nincs raktáron</availability>')
  })
  it('writes HUF prices in the Google feed', () => {
    expect(googleXml(items, 'https://bolt.hu')).toContain('<g:price>12990 HUF</g:price>')
  })
})
