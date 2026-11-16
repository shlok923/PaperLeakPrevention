import canonicalize from "canonicalize";
import sodium from "#sodium";
import { z } from "zod";
import { AbiCoder, getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";

const abi = AbiCoder.defaultAbiCoder();
const SUBJECT_COUNT = 3;
const ENTITY_COUNT = 3;
const SHIFT_COUNT = 6;
const QUESTIONS_PER_POOL = 50;
const QUESTIONS_PER_SHIFT = 75;

export type CommitteeReveal = {
  member: string;
  secret: string;
};

export type PoolMatrix = readonly (readonly (readonly number[])[])[];

const imageSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1),
  dataBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

export const questionPayloadSchema = z.object({
  v: z.literal(1),
  subject: z.enum(["P", "C", "M"]),
  text: z.string().min(1),
  options: z.array(z.string()).length(4),
  correct: z.number().int().min(0).max(3),
  images: z.array(imageSchema).optional(),
}).strict();

export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export type QuestionKeyShare = { index: number; data: Uint8Array };
export type CenterKeypair = { publicKey: string; privateKey: string };

export type EncryptedQuestion = {
  blob: Uint8Array;
  keyShares: QuestionKeyShare[];
  keyShareHashes: string[];
  objectId: string;
  ciphertextHash: string;
  plaintextCommitment: string;
};

/** RFC 8785 canonical JSON representation used for all signed and committed JSON values. */
export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError("value cannot be represented as canonical JSON");
  return result;
}

function assertBytes32(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a 32-byte hex value`);
  }
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return hexlify(bytes);
}

function parseHex(value: string, expectedLength: number, label: string): Uint8Array {
  const bytes = getBytes(value);
  if (bytes.length !== expectedLength) {
    throw new RangeError(`${label} must be ${expectedLength} bytes`);
  }
  return bytes;
}

/** Validates a question payload and enforces the SRS's 1 MiB canonical plaintext limit. */
export function validatePayload(value: unknown): QuestionPayload {
  const payload = questionPayloadSchema.parse(value);
  const canonical = canonicalJson(payload);
  if (toUtf8Bytes(canonical).length > 1_048_576) {
    throw new RangeError("canonical question payload exceeds 1 MiB");
  }
  return payload;
}

/** Creates an X25519 keypair for a share holder or center. */
export async function generateX25519Keypair(): Promise<CenterKeypair> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { publicKey: bytesToHex(pair.publicKey), privateKey: bytesToHex(pair.privateKey) };
}

/** Creates a center keypair for receiving released Shamir shares. */
export const generateCenterKeypair = generateX25519Keypair;

/** Seals one 32-byte Shamir share to a center's X25519 public key for transport. */
export async function sealShare(publicKey: string | Uint8Array, share: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  if (share.length !== 32) throw new RangeError("Shamir share must be 32 bytes");
  const pk = typeof publicKey === "string" ? parseHex(publicKey, 32, "publicKey") : publicKey;
  if (pk.length !== 32) throw new RangeError("center public key must be 32 bytes");
  return sodium.crypto_box_seal(share, pk);
}

/** Opens a center-transport sealed Shamir share. */
export async function unsealShare(
  sealedShare: Uint8Array,
  publicKey: string | Uint8Array,
  privateKey: string | Uint8Array,
): Promise<Uint8Array> {
  await sodium.ready;
  if (sealedShare.length !== 80) throw new RangeError("sealed Shamir share must be 80 bytes");
  const pk = typeof publicKey === "string" ? parseHex(publicKey, 32, "publicKey") : publicKey;
  const sk = typeof privateKey === "string" ? parseHex(privateKey, 32, "privateKey") : privateKey;
  if (pk.length !== 32 || sk.length !== 32) throw new RangeError("X25519 keys must be 32 bytes");
  return sodium.crypto_box_seal_open(sealedShare, pk, sk);
}

const SHAMIR_SHARE_COUNT = 5;
const SHAMIR_THRESHOLD = 3;

function gfMultiply(left: number, right: number): number {
  let a = left;
  let b = right;
  let product = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    if ((b & 1) !== 0) product ^= a;
    const highBit = a & 0x80;
    a = (a << 1) & 0xff;
    if (highBit !== 0) a ^= 0x1b;
    b >>>= 1;
  }
  return product;
}

function gfPower(value: number, exponent: number): number {
  let base = value;
  let result = 1;
  let power = exponent;
  while (power > 0) {
    if ((power & 1) !== 0) result = gfMultiply(result, base);
    base = gfMultiply(base, base);
    power >>>= 1;
  }
  return result;
}

function gfDivide(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError("cannot divide by zero in GF(256)");
  return gfMultiply(numerator, gfPower(denominator, 254));
}

/** Splits one 32-byte question AES key into five GF(256) Shamir shares; any three recover it. */
export function splitQuestionKey(key: Uint8Array): QuestionKeyShare[] {
  if (key.length !== 32) throw new RangeError("question key must be 32 bytes");
  const coefficients = randomBytes(32 * (SHAMIR_THRESHOLD - 1));
  const shares = Array.from({ length: SHAMIR_SHARE_COUNT }, (_, offset) => ({
    index: offset + 1,
    data: new Uint8Array(32),
  }));
  for (let byteIndex = 0; byteIndex < key.length; byteIndex += 1) {
    const linear = coefficients[byteIndex * 2]!;
    const quadratic = coefficients[byteIndex * 2 + 1]!;
    for (const share of shares) {
      const x = share.index;
      share.data[byteIndex] = key[byteIndex]! ^ gfMultiply(linear, x) ^ gfMultiply(gfMultiply(quadratic, x), x);
    }
  }
  coefficients.fill(0);
  return shares;
}

/** Reconstructs a question AES key from any three distinct Shamir shares. */
export function combineQuestionKeyShares(shares: readonly QuestionKeyShare[]): Uint8Array {
  if (shares.length < SHAMIR_THRESHOLD) throw new RangeError("at least three key shares are required");
  const selected = shares.slice(0, SHAMIR_THRESHOLD);
  const firstIndex = selected[0]?.index;
  if (firstIndex === undefined || selected.some((share) => !Number.isInteger(share.index) || share.index < 1 || share.index > SHAMIR_SHARE_COUNT || share.data.length !== 32)) {
    throw new TypeError("key shares have invalid indices or lengths");
  }
  if (new Set(selected.map((share) => share.index)).size !== SHAMIR_THRESHOLD) {
    throw new TypeError("key shares must have distinct indices");
  }
  const key = new Uint8Array(32);
  for (let byteIndex = 0; byteIndex < key.length; byteIndex += 1) {
    let value = 0;
    for (let i = 0; i < selected.length; i += 1) {
      const shareI = selected[i]!;
      let basis = 1;
      for (let j = 0; j < selected.length; j += 1) {
        if (i === j) continue;
        const shareJ = selected[j]!;
        basis = gfMultiply(basis, gfDivide(shareJ.index, shareI.index ^ shareJ.index));
      }
      value ^= gfMultiply(shareI.data[byteIndex]!, basis);
    }
    key[byteIndex] = value;
  }
  return key;
}

/** Encrypts one validated question and Shamir-splits its AES key across five holders. */
export async function encryptQuestion(payloadValue: unknown): Promise<EncryptedQuestion> {
  const payload = validatePayload(payloadValue);
  const canonical = canonicalJson(payload);
  const payloadBytes = toUtf8Bytes(canonical);
  const salt = randomBytes(32);
  const envelope = new Uint8Array(salt.length + payloadBytes.length);
  envelope.set(salt);
  envelope.set(payloadBytes, salt.length);
  const questionKey = randomBytes(32);
  const nonce = randomBytes(12);
  const objectIdBytes = randomBytes(16);
  const objectId = bytesToHex(objectIdBytes);
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", toArrayBuffer(questionKey), "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(objectIdBytes), tagLength: 128 },
    cryptoKey,
    toArrayBuffer(envelope),
  ));
  const blob = new Uint8Array(1 + nonce.length + encrypted.length);
  blob[0] = 1;
  blob.set(nonce, 1);
  blob.set(encrypted, 1 + nonce.length);
  const keyShares = splitQuestionKey(questionKey);
  const keyShareHashes = keyShares.map((share) => keccak256(share.data));
  questionKey.fill(0);
  return {
    blob,
    keyShares,
    keyShareHashes,
    objectId,
    ciphertextHash: keccak256(blob),
    plaintextCommitment: keccak256(envelope),
  };
}

/** Decrypts a blob with its 32-byte question key and objectId AAD, returning its salt and payload. */
export async function decryptQuestion(
  blob: Uint8Array,
  questionKey: Uint8Array,
  objectId: string,
): Promise<{ envelope: Uint8Array; salt: Uint8Array; payloadBytes: Uint8Array; payload: QuestionPayload }> {
  if (questionKey.length !== 32) throw new RangeError("question key must be 32 bytes");
  if (blob.length < 1 + 12 + 16 || blob[0] !== 1) throw new TypeError("unsupported or malformed ciphertext blob");
  const aad = parseHex(objectId, 16, "objectId");
  const nonce = blob.slice(1, 13);
  const ciphertext = blob.slice(13);
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", toArrayBuffer(questionKey), "AES-GCM", false, ["decrypt"]);
  const envelope = new Uint8Array(await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad), tagLength: 128 },
    cryptoKey,
    toArrayBuffer(ciphertext),
  ));
  if (envelope.length < 32) throw new TypeError("decrypted envelope is missing its salt");
  const salt = envelope.slice(0, 32);
  const payloadBytes = envelope.slice(32);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  const payload = validatePayload(JSON.parse(decoded) as unknown);
  return { envelope, salt, payloadBytes, payload };
}

/** Derives the SRS seed from ANU entropy followed by revealed committee members in registration order. */
export function computeSeed(anuValue: string, reveals: readonly CommitteeReveal[]): string {
  assertBytes32(anuValue, "anuValue");
  let seed = anuValue;
  for (const { member, secret } of reveals) {
    assertBytes32(secret, "secret");
    seed = keccak256(abi.encode(["bytes32", "address", "bytes32"], [seed, getAddress(member), secret]));
  }
  return seed;
}

/** Fisher–Yates shuffle with keccak256(abi.encode(seed, i)) as the deterministic index source. */
export function shuffle<T>(input: readonly T[], seed: string): T[] {
  assertBytes32(seed, "seed");
  const output = [...input];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const digest = BigInt(keccak256(abi.encode(["bytes32", "uint256"], [seed, i])));
    const j = Number(digest % BigInt(i + 1));
    [output[i], output[j]] = [output[j]!, output[i]!];
  }
  return output;
}

/** Constructs the six 75-question shift lists using the exact 9/8/8 rotating SRS split. */
export function slicePools(seed: string, pools: PoolMatrix): number[][] {
  assertBytes32(seed, "seed");
  if (pools.length !== SUBJECT_COUNT || pools.some((subject) => subject.length !== ENTITY_COUNT)) {
    throw new RangeError("pools must contain 3 subjects with 3 entity pools each");
  }

  const shifts = Array.from({ length: SHIFT_COUNT }, () => [] as number[]);
  for (let subject = 0; subject < SUBJECT_COUNT; subject += 1) {
    for (let entity = 0; entity < ENTITY_COUNT; entity += 1) {
      const pool = pools[subject]![entity]!;
      if (pool.length !== QUESTIONS_PER_POOL) {
        throw new RangeError(`pool (${subject}, ${entity}) must contain exactly 50 question IDs`);
      }
      const poolSeed = keccak256(abi.encode(["bytes32", "uint8", "uint8"], [seed, subject, entity]));
      const ascendingPool = [...pool].sort((left, right) => left - right);
      if (ascendingPool.some((id) => !Number.isSafeInteger(id) || id < 0)) {
        throw new TypeError(`pool (${subject}, ${entity}) must contain non-negative safe integer IDs`);
      }
      const ordered = shuffle(ascendingPool, poolSeed);
      let offset = 0;
      for (let shift = 0; shift < SHIFT_COUNT; shift += 1) {
        const count = entity === shift % ENTITY_COUNT ? 9 : 8;
        shifts[shift]!.push(...ordered.slice(offset, offset + count));
        offset += count;
      }
      if (offset !== QUESTIONS_PER_POOL) {
        throw new Error(`internal allocation error for pool (${subject}, ${entity})`);
      }
    }
  }

  for (let shift = 0; shift < SHIFT_COUNT; shift += 1) {
    const result = shifts[shift]!;
    if (result.length !== QUESTIONS_PER_SHIFT) {
      throw new Error(`internal allocation error for shift ${shift}: expected 75, got ${result.length}`);
    }
    // Regroup each 25-question block explicitly so the canonical subject boundaries stay clear.
    const subjectBlocks: number[][] = [];
    let cursor = 0;
    for (let subject = 0; subject < SUBJECT_COUNT; subject += 1) {
      const width = ENTITY_COUNT * 8 + 1;
      subjectBlocks.push(result.slice(cursor, cursor + width));
      cursor += width;
    }
    shifts[shift] = subjectBlocks.flat();
  }

  return shifts;
}

/** Applies deterministic center-specific ordering independently inside each 25-question subject section. */
export function centerOrder(seed: string, center: string, shiftQuestions: readonly number[]): number[] {
  assertBytes32(seed, "seed");
  if (shiftQuestions.length !== QUESTIONS_PER_SHIFT) {
    throw new RangeError("shiftQuestions must contain exactly 75 question IDs");
  }
  const normalizedCenter = getAddress(center);
  const result: number[] = [];
  for (let subject = 0; subject < SUBJECT_COUNT; subject += 1) {
    const section = shiftQuestions.slice(subject * 25, (subject + 1) * 25);
    const sectionSeed = keccak256(abi.encode(["bytes32", "address", "uint8"], [seed, normalizedCenter, subject]));
    result.push(...shuffle(section, sectionSeed));
  }
  return result;
}
