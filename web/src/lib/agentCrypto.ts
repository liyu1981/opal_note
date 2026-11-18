/**
 * Client-side half of the agent credential.
 *
 * The password never leaves the browser: we derive a 256-bit key from it with
 * PBKDF2-SHA256, encrypt the upstream API key with AES-256-GCM, and hand the
 * server only the envelope. Every proxied request carries the derived key, so
 * the server can decrypt the stored key for that one call and forget it.
 *
 * Everything here needs `crypto.subtle`, i.e. a secure context (HTTPS or
 * localhost). On plain-HTTP LAN origins the setup form says so instead of
 * failing obscurely.
 */

/** Envelope format version; the server rejects anything else. */
const ENVELOPE_VERSION = 1;
const KDF = "PBKDF2-SHA256";
/** OWASP-recommended floor for PBKDF2-SHA256 (2023). */
const KDF_ITERATIONS = 600_000;
const DERIVED_BITS = 256;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

export type KeyEnvelope = {
  v: number;
  kdf: string;
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export type SealedCredential = {
  /** Envelope for the server; it never sees the password or the plain key. */
  envelope: KeyEnvelope;
  /** Raw derived key, kept in memory for the unlock window. */
  derivedKey: string;
};

export class CryptoUnavailableError extends Error {
  constructor() {
    super(
      "Encryption needs a secure context. Open OpalNote over HTTPS or on localhost.",
    );
    this.name = "CryptoUnavailableError";
  }
}

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new CryptoUnavailableError();
  }
  return crypto.subtle;
}

/** WebCrypto wants `ArrayBuffer`-backed views, not `SharedArrayBuffer` ones. */
type Bytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Bytes | Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveBits(
  password: string,
  salt: Bytes,
  iterations: number,
): Promise<ArrayBuffer> {
  const base = await subtle().importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return subtle().deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    DERIVED_BITS,
  );
}

async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Stable fingerprint of an envelope, used to invalidate a cached unlock. */
export async function envelopeFingerprint(
  envelope: KeyEnvelope,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(envelope));
  const digest = await subtle().digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Encrypt the API key for storage; also returns the derived key to reuse. */
export async function sealApiKey(
  password: string,
  apiKey: string,
): Promise<SealedCredential> {
  const salt = randomBytes(SALT_BYTES);
  const derived = new Uint8Array(
    await deriveBits(password, salt, KDF_ITERATIONS),
  );
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce },
    await aesKey(derived),
    new TextEncoder().encode(apiKey),
  );
  return {
    envelope: {
      v: ENVELOPE_VERSION,
      kdf: KDF,
      iterations: KDF_ITERATIONS,
      salt: toBase64(salt),
      nonce: toBase64(nonce),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    },
    derivedKey: toBase64(derived),
  };
}

/**
 * Re-encrypt a new API key with a session that is already unlocked: keeps the
 * envelope's KDF parameters (so the same password still derives this key) and
 * only replaces the nonce and ciphertext.
 */
export async function resealWithDerivedKey(
  apiKey: string,
  envelope: KeyEnvelope,
  derivedKey: string,
): Promise<KeyEnvelope> {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce },
    await aesKey(fromBase64(derivedKey)),
    new TextEncoder().encode(apiKey),
  );
  return {
    ...envelope,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Re-derive the key from the password and the stored envelope parameters. */
export async function deriveUnlockKey(
  password: string,
  envelope: KeyEnvelope,
): Promise<string> {
  if (envelope.kdf !== KDF) {
    throw new Error(`Unsupported key derivation: ${envelope.kdf}`);
  }
  const salt = fromBase64(envelope.salt);
  const derived = new Uint8Array(
    await deriveBits(password, salt, envelope.iterations || KDF_ITERATIONS),
  );
  return toBase64(derived);
}

/**
 * Local sanity check before uploading an envelope: can this password open it?
 * The server is the only place that decrypts for real, but a mistyped password
 * should not be discovered at the first chat message.
 */
export async function canDecrypt(
  derivedKey: string,
  envelope: KeyEnvelope,
): Promise<boolean> {
  try {
    await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.nonce) },
      await aesKey(fromBase64(derivedKey)),
      fromBase64(envelope.ciphertext),
    );
    return true;
  } catch {
    return false;
  }
}

/** Parse and shape-check an envelope that came back from the server. */
export function parseEnvelope(value: unknown): KeyEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<KeyEnvelope>;
  if (
    candidate.v !== ENVELOPE_VERSION ||
    typeof candidate.kdf !== "string" ||
    typeof candidate.salt !== "string" ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.ciphertext !== "string"
  ) {
    return null;
  }
  return {
    v: candidate.v,
    kdf: candidate.kdf,
    iterations:
      typeof candidate.iterations === "number"
        ? candidate.iterations
        : KDF_ITERATIONS,
    salt: candidate.salt,
    nonce: candidate.nonce,
    ciphertext: candidate.ciphertext,
  };
}
