// Prime field and Shamir secret sharing, compatible with MPyC.
//
// MPyC's SecInt(64) works over GF(P) with the prime below. With 3 parties and the
// default threshold t = 1, party i (0-based) holds f(i + 1) for a random polynomial
// f of degree 1 whose constant term is the secret. Any one share is uniformly
// random; any two reconstruct the secret.

/** The MPyC SecInt(64) field modulus. Parties check they agree with it at startup. */
export const P = 79228162514264337593543950319n;

/** Number of computing parties and the polynomial degree (threshold). */
export const PARTIES = 3;
export const THRESHOLD = 1;

/** Bids are shared bit by bit. 2^52 zatoshi is ~45 million ZEC, above total supply. */
export const BID_BITS = 52;

export const mod = (a, m = P) => ((a % m) + m) % m;

/** Uniform random field element from a CSPRNG. */
export function randomFieldElement() {
  // 16 random bytes (128 bits) reduced mod a 96-bit prime: bias below 2^-32.
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  let x = 0n;
  for (const b of buf) x = (x << 8n) | BigInt(b);
  return mod(x);
}

/**
 * Split a secret into Shamir shares for MPyC's default 3-party, t=1 setting.
 * @param {bigint} secret
 * @param {number} [parties]
 * @param {number} [threshold]
 * @returns {bigint[]} share for party 0..parties-1
 */
export function shamirShare(secret, parties = PARTIES, threshold = THRESHOLD) {
  const coeffs = [mod(BigInt(secret))];
  for (let k = 0; k < threshold; k++) coeffs.push(randomFieldElement());
  const shares = [];
  for (let i = 1; i <= parties; i++) {
    let acc = 0n;
    let pow = 1n;
    for (const c of coeffs) {
      acc = mod(acc + c * pow);
      pow = mod(pow * BigInt(i));
    }
    shares.push(acc);
  }
  return shares;
}

function modInverse(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

/**
 * Reconstruct a secret from shares by Lagrange interpolation at 0.
 * Used in tests only: in production no single machine ever sees enough shares.
 * @param {{x: number, y: bigint}[]} points  x is the 1-based party position
 */
export function shamirReconstruct(points) {
  let secret = 0n;
  for (const { x: xi, y: yi } of points) {
    let num = 1n;
    let den = 1n;
    for (const { x: xj } of points) {
      if (xj === xi) continue;
      num = mod(num * BigInt(-xj));
      den = mod(den * BigInt(xi - xj));
    }
    secret = mod(secret + yi * num * modInverse(den));
  }
  return secret;
}

/**
 * Share a bid bit by bit. Returns, for each party, its 52 bit-shares (as decimal
 * strings, least significant bit first). Sharing bits instead of the number lets
 * the parties prove every bid lies in [0, 2^52) without learning it.
 * @param {bigint} amountZat
 * @returns {string[][]} shares[party][bit]
 */
export function shareBid(amountZat) {
  const amount = BigInt(amountZat);
  if (amount < 0n || amount >= 1n << BigInt(BID_BITS)) {
    throw new RangeError(`bid must be between 0 and 2^${BID_BITS} zatoshi`);
  }
  const perParty = Array.from({ length: PARTIES }, () => []);
  for (let j = 0; j < BID_BITS; j++) {
    const bit = (amount >> BigInt(j)) & 1n;
    const s = shamirShare(bit);
    for (let i = 0; i < PARTIES; i++) perParty[i].push(s[i].toString());
  }
  return perParty;
}
