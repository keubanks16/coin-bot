// Solana program-derived addresses (PDAs), so the bot can compute a graduated coin's PumpSwap
// pool address itself instead of searching for it (RPC providers block that search).
// Same algorithm as Solana's Pubkey::find_program_address.

import { b58decode, b58encode } from './solana.js';

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));

/** True if 32 bytes decode to a point on the ed25519 curve (PDAs must NOT be). */
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u * v^3 * (u * v^7)^((p-5)/8); a square root of u/v exists iff v*x^2 == ±u.
  const v3 = (v * v * v) % P;
  const x = (u * v3 % P) * pow(u * ((v3 * v3 % P) * v % P), (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  // If v*x^2 == -u, then x*sqrt(-1) is the root instead; either way a point exists.
  return vx2 === u || vx2 === mod(-u);
}

const enc = new TextEncoder();
const toBytes = (s) => (typeof s === 'string' ? enc.encode(s) : s);

/** [address, bump] for these seeds under a program. Seeds are strings (UTF-8) or byte arrays. */
export async function findProgramAddress(seeds, programId) {
  const program = b58decode(programId);
  const parts = seeds.map(toBytes);
  for (let bump = 255; bump >= 0; bump--) {
    const all = [...parts, Uint8Array.of(bump), program, enc.encode('ProgramDerivedAddress')];
    const buf = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of all) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (!isOnCurve(hash)) return [b58encode(hash), bump];
  }
  throw new Error('no viable bump');
}

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

/** The pool pump.fun creates when a coin graduates (from pump.fun's published program IDL). */
export async function canonicalPumpPool(mint) {
  const [authority] = await findProgramAddress(['pool-authority', b58decode(mint)], PUMP_PROGRAM);
  const [pool] = await findProgramAddress(['pool', Uint8Array.of(0, 0), b58decode(authority), b58decode(mint), b58decode(WSOL)], PUMP_AMM_PROGRAM);
  return { pool, authority };
}
