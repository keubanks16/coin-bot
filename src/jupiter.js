// Thin client for Jupiter's Swap v2 (Meta-Aggregator), Price v3 and Tokens v2 APIs.
// Docs: https://developers.jup.ag/docs/swap  /docs/price  /docs/tokens

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
export const SOL = 'So11111111111111111111111111111111111111112';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared across every client in this isolate, so all calls respect the key's rate limit.
let nextSlot = 0;

export class Jupiter {
  constructor(env) {
    this.base = (env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/$/, '');
    this.key = env.JUPITER_API_KEY || '';
    const rps = Number(env.JUP_RPS) > 0 ? Number(env.JUP_RPS) : 1;
    this.gapMs = Math.ceil(1000 / rps);
  }

  /** Space requests out to stay under the API key's requests-per-second budget. */
  async throttle() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + this.gapMs;
    if (at > now) await sleep(at - now);
  }

  headers(extra = {}) {
    const h = { accept: 'application/json', ...extra };
    if (this.key) h['x-api-key'] = this.key;
    return h;
  }

  async request(path, init = {}, attempt = 0) {
    // /swap/v2/execute has its own, much larger bucket — don't make live fills wait in line.
    if (!path.startsWith('/swap/v2/execute')) await this.throttle();
    const res = await fetch(this.base + path, { ...init, headers: this.headers(init.headers) });
    if (res.status === 429 && attempt < 2) {
      nextSlot = Math.max(nextSlot, Date.now() + 1000 * (attempt + 1));
      return this.request(path, init, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jupiter ${path.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** Quote + (if taker given) an unsigned transaction. amount is a raw integer string. */
  order({ inputMint, outputMint, amount, taker }) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount) });
    if (taker) q.set('taker', taker);
    return this.request(`/swap/v2/order?${q}`);
  }

  execute(signedTransaction, requestId) {
    return this.request('/swap/v2/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction, requestId }),
    });
  }

  /** Returns { mint: { usdPrice, decimals, priceChange24h } } — unpriced mints are omitted. */
  async prices(mints) {
    const out = {};
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50);
      if (!chunk.length) continue;
      Object.assign(out, await this.request(`/price/v3?ids=${chunk.join(',')}`));
    }
    return out;
  }

  /** category: toptrending | toptraded | toporganicscore ; interval: 5m | 1h | 6h | 24h */
  category(category, interval, limit = 100) {
    return this.request(`/tokens/v2/${category}/${interval}?limit=${limit}`);
  }

  search(query) {
    return this.request(`/tokens/v2/search?query=${encodeURIComponent(query)}`);
  }
}
