// Minimal Solana helpers for Cloudflare Workers: base58, keypair loading from a
// Phantom export, and signing the versioned transactions Jupiter returns.
// No dependencies: uses the runtime's built-in WebCrypto Ed25519.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error('Invalid base58 character');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

export function b58encode(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of buf) {
    if (byte === 0) out += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64decode(s);
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Load a keypair from what Phantom's "Show Private Key" gives you (a base58
 * string of 64 bytes), or from a Solana CLI JSON byte array.
 * Returns { publicKey (base58), publicKeyBytes, privateKey (CryptoKey) }.
 */
export async function loadKeypair(secret) {
  if (!secret) throw new Error('WALLET_PRIVATE_KEY is not set');
  secret = secret.trim();
  const raw = secret.startsWith('[')
    ? Uint8Array.from(JSON.parse(secret))
    : b58decode(secret);
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(`Private key should be 64 bytes (got ${raw.length})`);
  }
  const seed = raw.slice(0, 32);
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKeyBytes = b64urlDecode(jwk.x);
  if (raw.length === 64) {
    const given = raw.slice(32);
    if (given.some((b, i) => b !== publicKeyBytes[i])) {
      throw new Error('Private key and public key halves do not match');
    }
  }
  return { publicKey: b58encode(publicKeyBytes), publicKeyBytes, privateKey };
}

function readCompactU16(bytes, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = bytes[offset + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error('Bad compact-u16');
  }
  return { value, size };
}

/**
 * Sign a base64 Solana transaction (legacy or v0) with our key and return it
 * base64 again. Other signature slots (e.g. a Jupiter gasless payer or an RFQ
 * market maker) are left untouched, which matches Jupiter's partial-sign flow.
 */
export async function signTransaction(txBase64, keypair) {
  const tx = b64decode(txBase64);
  const sigCount = readCompactU16(tx, 0);
  const sigStart = sigCount.size;
  const msgStart = sigStart + sigCount.value * 64;
  const message = tx.subarray(msgStart);

  let p = 0;
  const versioned = (message[0] & 0x80) !== 0;
  if (versioned) {
    const version = message[0] & 0x7f;
    if (version !== 0) throw new Error(`Unsupported transaction version ${version}`);
    p = 1;
  }
  const numRequiredSignatures = message[p];
  p += 3;
  const keyCount = readCompactU16(message, p);
  p += keyCount.size;

  let slot = -1;
  for (let i = 0; i < Math.min(numRequiredSignatures, keyCount.value); i++) {
    const key = message.subarray(p + i * 32, p + i * 32 + 32);
    if (key.every((b, j) => b === keypair.publicKeyBytes[j])) {
      slot = i;
      break;
    }
  }
  if (slot < 0) throw new Error('Our wallet is not a required signer of this transaction');
  if (slot >= sigCount.value) throw new Error('Signature slot out of range');

  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keypair.privateKey, message));
  const out = new Uint8Array(tx);
  out.set(sig, sigStart + slot * 64);
  return b64encode(out);
}
