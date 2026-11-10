/**
 * SSRF guard for the shop-analysis crawler.
 *
 * The crawler fetches URLs built from a user-supplied domain, so every hop
 * (including redirects) must resolve to a public address only.
 *
 * Also enforces a response body size cap (default 5 MB) and a per-request
 * timeout (default 15 s) to prevent slow-loris / giant-response attacks.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { FetchFn } from './fetcher.js'

/** Public DNS hostname only: no IP literals, no ports, no single-label hosts like `localhost`. */
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function isValidPublicHostname(host: string): boolean {
  return HOSTNAME_RE.test(host) && isIP(host) === 0
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and IPv4-mapped equivalents. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    return (
      s === '::' || s === '::1' ||
      s.startsWith('fc') || s.startsWith('fd') ||
      /^fe[89ab]/.test(s) ||
      s.startsWith('ff')
    )
  }
  return true
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Tiltott protokoll: ${url.protocol}`)
  if (url.port && url.port !== '443' && url.port !== '80') throw new Error(`Tiltott port: ${url.port}`)
  const host = url.hostname.toLowerCase()
  if (!isValidPublicHostname(host)) throw new Error(`Tiltott hoszt: ${host}`)
  const addrs = await lookup(host, { all: true })
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`Belső címre mutató hoszt: ${host}`)
  return url
}

/** Read a Response body up to `maxBytes`, throwing if the limit is exceeded. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          reader.cancel().catch(() => {})
          throw new Error(`Túl nagy válasz: >${maxBytes} bájt`)
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(combined)
}

const MAX_REDIRECTS = 3
/** Default response body size cap: 5 MB. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Default per-request timeout: 15 s. */
export const DEFAULT_TIMEOUT_MS = 15_000

export type SafeFetchOptions = {
  /** Maximum response body size in bytes (default 5 MB). */
  maxBytes?: number
  /** Abort the fetch after this many ms (default 15 000). */
  timeoutMs?: number
}

/** fetch() wrapper that validates the target (and every redirect hop) against private/reserved
 *  addresses, enforces a body size cap, and aborts slow/huge responses. */
export function makeSafeFetch(opts: SafeFetchOptions = {}): FetchFn {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (rawUrl, init) => {
    let url = await assertPublicUrl(rawUrl)
    for (let hop = 0; ; hop++) {
      const signal = AbortSignal.timeout(timeoutMs)
      const r = await fetch(url, { ...init, redirect: 'manual', signal })
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null
      if (!loc) {
        const bodyText = await readBodyCapped(r, maxBytes)
        return {
          ok: r.ok,
          status: r.status,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText) as unknown,
        }
      }
      if (hop >= MAX_REDIRECTS) throw new Error('Túl sok átirányítás')
      // Consume (discard) redirect body to free the connection
      r.body?.cancel().catch(() => {})
      url = await assertPublicUrl(new URL(loc, url).toString())
    }
  }
}

/** Default safeFetch instance used by the crawler (5 MB cap, 15 s timeout). */
export const safeFetch: FetchFn = makeSafeFetch()
