// Read-only Solana RPC calls used in live mode (wallet balances).
// Default is the free public endpoint; a Helius/QuickNode URL is more reliable.

export class Rpc {
  static start = 0;

  constructor(env) {
    // Your own URL first (SOLANA_RPC_URL, e.g. a free Helius key), then free public endpoints.
    // The official public endpoint blocks some cloud providers, so it goes last.
    this.urls = [env.SOLANA_RPC_URL, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
    this.url = this.urls[0];
  }

  async call(method, params) {
    let lastErr;
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(Rpc.start + i) % this.urls.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
        }
        if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
        // Remember the endpoint that worked, so the next call starts there.
        Rpc.start = (Rpc.start + i) % this.urls.length;
        return body.result;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /** Raw account data (Uint8Array, or null if missing) for up to 100 accounts in one call. */
  async multipleAccounts(keys, commitment = 'processed') {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const r = await this.call('getMultipleAccounts', [chunk, { encoding: 'base64', commitment }]);
      for (const acc of r.value || []) out.push(acc ? Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0)) : null);
    }
    return out;
  }

  async solBalance(owner) {
    const r = await this.call('getBalance', [owner, { commitment: 'confirmed' }]);
    return r.value / 1e9;
  }

  /** Raw (integer string) balance of one token mint, summed across the owner's token accounts. */
  async tokenBalanceRaw(owner, mint) {
    const r = await this.call('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    let total = 0n;
    for (const acc of r.value || []) {
      total += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
    }
    return total.toString();
  }
}
