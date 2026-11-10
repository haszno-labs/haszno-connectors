const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type ExportProduct = { sku: string; name: string; priceGross: number; stock: number }

/** Árukereső-style product feed (the common <products><product> shape). */
export function arukeresoXml(items: ExportProduct[], baseUrl: string): string {
  const body = items
    .map(
      (p) => `  <product>
    <identifier>${esc(p.sku)}</identifier>
    <name>${esc(p.name)}</name>
    <price>${p.priceGross}</price>
    <product_url>${esc(`${baseUrl}/termek/${encodeURIComponent(p.sku)}`)}</product_url>
    <availability>${p.stock > 0 ? 'raktáron' : 'nincs raktáron'}</availability>
  </product>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<products>\n${body}\n</products>\n`
}

/** Google Merchant Center RSS 2.0 feed. */
export function googleXml(items: ExportProduct[], baseUrl: string): string {
  const body = items
    .map(
      (p) => `    <item>
      <g:id>${esc(p.sku)}</g:id>
      <title>${esc(p.name)}</title>
      <link>${esc(`${baseUrl}/termek/${encodeURIComponent(p.sku)}`)}</link>
      <g:price>${p.priceGross} HUF</g:price>
      <g:availability>${p.stock > 0 ? 'in_stock' : 'out_of_stock'}</g:availability>
      <g:condition>new</g:condition>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Haszno feed</title>
    <link>${esc(baseUrl)}</link>
    <description>Termékfeed</description>
${body}
  </channel>
</rss>
`
}
