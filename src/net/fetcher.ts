/**
 * Injectable HTTP fetch adapter type for testability.
 *
 * All adapter classes accept an optional `fetchFn` constructor parameter of this
 * type so network calls can be mocked in tests without touching the network.
 *
 * Production code uses `safeFetch` from `../net/safe-fetch.js` as the default.
 */

/** Injectable HTTP fetch adapter — for testability. */
export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>
