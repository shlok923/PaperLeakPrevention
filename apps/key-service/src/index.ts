import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  getBytes,
  keccak256,
  toUtf8Bytes,
  toBeHex,
  verifyMessage,
  zeroPadValue,
} from "ethers";
import { canonicalJson, sealShare, unsealShare } from "@eplps/crypto";
import { createExamManager, EXAM_MANAGER_ABI } from "@eplps/shared";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive(),
  CHAIN_RPC_URL: z.string().url(),
  CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  CONFIRMATIONS: z.coerce.number().int().positive().default(1),
  KEY_SHARE_INDEX: z.coerce.number().int().min(1).max(5),
  KEY_SERVICE_SIGNER_PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
  KEY_SHARE_PRIVATE_KEY_FILE: z.string().min(1),
  KEY_SERVICE_PORT: z.coerce.number().int().positive().default(3001),
  KEY_SERVICE_AUDIT_FILE: z.string().optional(),
  KEY_PACKAGE_CACHE_DIR: z.string().default(".keys/packages"),
});

const requestSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
}).strict();

type ServiceConfig = z.infer<typeof envSchema>;
type RequestBody = z.infer<typeof requestSchema>;
type SubmissionRecord = {
  keyShareHashes: readonly string[];
};
type PackageEntry = { questionId: number; sealedShare: string };
type KeyPackage = {
  chainId: number;
  contract: string;
  shiftId: number;
  center: string;
  shareIndex: number;
  issuedAt: number;
  entries: PackageEntry[];
  signature: string;
};
type AuditSharePackage = {
  chainId: number;
  contract: string;
  shareIndex: number;
  entries: Array<{ questionId: number; share: string }>;
  signature: string;
};
type AuditEntry = {
  timestamp: number;
  outcome: "accepted" | "rejected";
  txHash?: string;
  center?: string;
  errorCode?: string;
  previousHash: string;
  hash: string;
};

class RequestFailure extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

function requiredEnv(): ServiceConfig {
  return envSchema.parse(process.env);
}

function packageBody(pkg: Omit<KeyPackage, "signature">): Omit<KeyPackage, "signature"> {
  return pkg;
}

function hashAuditBody(entry: Omit<AuditEntry, "hash">): string {
  return keccak256(toUtf8Bytes(canonicalJson(entry)));
}

class HashChainAuditLog {
  #previousHash = `0x${"00".repeat(32)}`;

  constructor(private readonly file: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const content = await readFile(this.file, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines.at(-1)!) as AuditEntry;
        if (!/^0x[0-9a-fA-F]{64}$/.test(last.hash)) throw new Error("invalid audit log hash");
        this.#previousHash = last.hash;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async append(input: Omit<AuditEntry, "hash" | "previousHash" | "timestamp">): Promise<void> {
    const base = {
      timestamp: Math.floor(Date.now() / 1000),
      ...input,
      previousHash: this.#previousHash,
    };
    const hash = hashAuditBody(base);
    const line: AuditEntry = { ...base, hash };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
    this.#previousHash = hash;
  }
}

async function main(): Promise<void> {
  const config = requiredEnv();
  const contractAddress = getAddress(config.CONTRACT_ADDRESS);
  const provider = new JsonRpcProvider(config.CHAIN_RPC_URL, config.CHAIN_ID);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.CHAIN_ID) throw new Error("configured CHAIN_ID does not match RPC network");

  const signer = new Wallet(config.KEY_SERVICE_SIGNER_PRIVATE_KEY, provider);
  const contract = createExamManager(contractAddress, provider) as Contract;
  const registeredHolder: string = await contract.getFunction("committee")(config.KEY_SHARE_INDEX - 1);
  if (getAddress(registeredHolder) !== getAddress(signer.address)) {
    throw new Error("share-holder signer does not match its registered committee index");
  }
  const resolveProjectPath = (configuredPath: string) => path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
  const holderKey = JSON.parse(await readFile(resolveProjectPath(config.KEY_SHARE_PRIVATE_KEY_FILE), "utf8")) as { publicKey: string; privateKey: string };
  if (!/^0x[0-9a-fA-F]{64}$/.test(holderKey.publicKey) || !/^0x[0-9a-fA-F]{64}$/.test(holderKey.privateKey)) {
    throw new Error("share-holder key file must contain 32-byte X25519 publicKey and privateKey values");
  }
  const registeredHolderKey: string = await contract.getFunction("keyHolderPublicKeys")(config.KEY_SHARE_INDEX - 1);
  if (registeredHolderKey.toLowerCase() !== holderKey.publicKey.toLowerCase()) {
    throw new Error("share-holder key file does not match its registered on-chain public key");
  }
  const keyOpenBefore = Number(await contract.getFunction("keyOpenBefore")());
  const keyCloseAfter = Number(await contract.getFunction("keyCloseAfter")());
  const auditFile = config.KEY_SERVICE_AUDIT_FILE ?? `.keys/key-holder-${config.KEY_SHARE_INDEX}-audit.jsonl`;
  const audit = new HashChainAuditLog(resolveProjectPath(auditFile));
  await audit.initialize();
  const packageCacheDir = resolveProjectPath(config.KEY_PACKAGE_CACHE_DIR);
  await mkdir(packageCacheDir, { recursive: true });

  const sharesByShift = new Map<number, Map<number, Uint8Array>>();
  const shareLoadsByShift = new Map<number, Promise<Map<number, Uint8Array>>>();
  const packageLoads = new Map<string, Promise<KeyPackage>>();
  const rateByCenter = new Map<string, { start: number; count: number }>();
  const app = Fastify({ logger: true, bodyLimit: 32_000 });

  app.get("/health", async () => ({ service: "eplps-key-holder", shareIndex: config.KEY_SHARE_INDEX, status: "ok" }));

  async function loadQuestionShare(questionId: number, record?: SubmissionRecord): Promise<Uint8Array> {
    const submission = record ?? await contract.getFunction("getSubmission")(questionId) as SubmissionRecord;
    const event = contract.interface.getEvent("KeySharePublished");
    if (!event) throw new Error("KeySharePublished event is missing from the contract ABI");
    const logs = await provider.getLogs({
      address: contractAddress,
      fromBlock: 0,
      toBlock: "latest",
      topics: [event.topicHash, zeroPadValue(toBeHex(questionId), 32), zeroPadValue(toBeHex(config.KEY_SHARE_INDEX), 32)],
    });
    if (logs.length !== 1) throw new Error(`expected one on-chain share event for question ${questionId}, got ${logs.length}`);
    const parsed = contract.interface.parseLog({ topics: [...logs[0]!.topics], data: logs[0]!.data });
    if (parsed?.name !== "KeySharePublished") throw new Error("on-chain key-share event could not be decoded");
    const encryptedShare = getBytes(parsed.args.encryptedShare as string);
    const share = await unsealShare(encryptedShare, holderKey.publicKey, holderKey.privateKey);
    if (share.length !== 32 || keccak256(share) !== submission.keyShareHashes[config.KEY_SHARE_INDEX - 1]) {
      throw new Error(`on-chain share hash mismatch for question ${questionId}, holder ${config.KEY_SHARE_INDEX}`);
    }
    return share;
  }

  async function loadShiftShares(shiftId: number): Promise<Map<number, Uint8Array>> {
    const existing = sharesByShift.get(shiftId);
    if (existing) return existing;
    const inFlight = shareLoadsByShift.get(shiftId);
    if (inFlight) return inFlight;

    const loading = (async () => {
      const idsResult: readonly (bigint | number)[] = await contract.getFunction("getShiftQuestions")(shiftId);
      if (idsResult.length !== 75) throw new Error("on-chain shift list does not contain 75 questions");
      const questionShares = new Map<number, Uint8Array>();
      const loaded = await Promise.all(idsResult.map(async (rawId) => {
        const questionId = Number(rawId);
        const share = await loadQuestionShare(questionId);
        return [questionId, share] as const;
      }));
      for (const [questionId, share] of loaded) questionShares.set(questionId, share);
      if (questionShares.size !== 75) throw new Error("shift key set contains duplicate question IDs");
      sharesByShift.set(shiftId, questionShares);
      return questionShares;
    })();
    shareLoadsByShift.set(shiftId, loading);
    try {
      return await loading;
    } finally {
      shareLoadsByShift.delete(shiftId);
    }
  }

  async function getOrCreatePackage(shiftId: number, center: string, centerPublicKey: string): Promise<KeyPackage> {
    const cacheFile = path.join(packageCacheDir, `share-${config.KEY_SHARE_INDEX}-${shiftId}-${center.toLowerCase()}.json`);
    try {
      return JSON.parse(await readFile(cacheFile, "utf8")) as KeyPackage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const cacheKey = `${shiftId}-${center.toLowerCase()}`;
    const inFlight = packageLoads.get(cacheKey);
    if (inFlight) return inFlight;

    const creating = createPackage(shiftId, center, centerPublicKey, cacheFile);
    packageLoads.set(cacheKey, creating);
    try {
      return await creating;
    } finally {
      packageLoads.delete(cacheKey);
    }
  }

  async function createPackage(shiftId: number, center: string, centerPublicKey: string, cacheFile: string): Promise<KeyPackage> {
    const questionShares = await loadShiftShares(shiftId);
    const entries: PackageEntry[] = [];
    for (const [questionId, share] of questionShares) {
      const sealedShare = await sealShare(centerPublicKey, share);
      entries.push({ questionId, sealedShare: Buffer.from(sealedShare).toString("base64") });
    }
    entries.sort((left, right) => left.questionId - right.questionId);
    const unsigned = packageBody({
      chainId: config.CHAIN_ID,
      contract: contractAddress,
      shiftId,
      center,
      shareIndex: config.KEY_SHARE_INDEX,
      issuedAt: Math.floor(Date.now() / 1000),
      entries,
    });
    const signature = await signer.signMessage(getBytes(keccak256(toUtf8Bytes(canonicalJson(unsigned)))));
    const result: KeyPackage = { ...unsigned, signature };
    const tempFile = `${cacheFile}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
    await rename(tempFile, cacheFile);
    return result;
  }

  app.post("/v1/package", async (request, reply) => {
    let txHash: string | undefined;
    let centerAddress: string | undefined;
    try {
      const body: RequestBody = requestSchema.parse(request.body);
      txHash = body.txHash;
      if (Math.abs(Math.floor(Date.now() / 1000) - body.timestamp) > 120) {
        throw new RequestFailure(400, "stale_request_timestamp");
      }
      const requestMessage = `EPLPS-KEYREQ:${config.CHAIN_ID}:${contractAddress}:${body.txHash}:${body.timestamp}`;
      centerAddress = getAddress(verifyMessage(requestMessage, body.signature));
      const rate = rateByCenter.get(centerAddress.toLowerCase());
      const now = Date.now();
      if (rate && now - rate.start < 60_000 && rate.count >= 120) {
        throw new RequestFailure(429, "center_rate_limit");
      }
      rateByCenter.set(centerAddress.toLowerCase(), !rate || now - rate.start >= 60_000
        ? { start: now, count: 1 }
        : { start: rate.start, count: rate.count + 1 });

      const receipt = await provider.getTransactionReceipt(body.txHash);
      if (!receipt || receipt.status !== 1 || !receipt.to || getAddress(receipt.to) !== contractAddress) {
        throw new RequestFailure(403, "key_request_transaction_invalid");
      }
      const latestBlock = await provider.getBlockNumber();
      if (latestBlock - receipt.blockNumber + 1 < config.CONFIRMATIONS) {
        throw new RequestFailure(403, "key_request_not_finalized");
      }
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block) throw new RequestFailure(403, "key_request_block_unavailable");

      let requestedShift: number | undefined;
      let eventCenter: string | undefined;
      let requestLogIndex = -1;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== contractAddress) continue;
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "KeyRequested") {
          eventCenter = getAddress(parsed.args.center as string);
          requestedShift = Number(parsed.args.shiftId);
          requestLogIndex = log.index;
          break;
        }
      }
      if (!eventCenter || requestedShift === undefined || eventCenter !== centerAddress) {
        throw new RequestFailure(403, "key_request_event_missing_or_mismatched");
      }

      const atRequest = { blockTag: receipt.blockNumber };
      const registrationTopic = contract.interface.getEvent("CenterRegistered")!.topicHash;
      const revokeTopic = contract.interface.getEvent("CenterRevoked")!.topicHash;
      const centerHistory = await provider.getLogs({
        address: contractAddress,
        fromBlock: 0,
        toBlock: receipt.blockNumber,
        topics: [[registrationTopic, revokeTopic], zeroPadValue(centerAddress, 32)],
      });
      centerHistory.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);
      let registered = false;
      let revoked = false;
      let registeredShift = -1;
      let centerPublicKey = "";
      for (const log of centerHistory) {
        if (log.blockNumber > receipt.blockNumber || (log.blockNumber === receipt.blockNumber && log.index >= requestLogIndex)) break;
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "CenterRegistered") {
          registered = true;
          revoked = false;
          registeredShift = Number(parsed.args.shiftId);
          centerPublicKey = String(parsed.args.x25519PubKey);
        } else if (parsed?.name === "CenterRevoked") {
          revoked = true;
        }
      }
      if (!registered || revoked || registeredShift !== requestedShift) {
        throw new RequestFailure(403, "center_not_eligible_at_request");
      }
      const shiftState = await contract.getFunction("shifts")(requestedShift, atRequest);
      const opensAt = Number(shiftState.startTime) - keyOpenBefore;
      const closesAt = Number(shiftState.startTime) + keyCloseAfter;
      if (block.timestamp < opensAt || block.timestamp > closesAt) {
        throw new RequestFailure(403, "key_request_outside_shift_window");
      }

      const result = await getOrCreatePackage(requestedShift, centerAddress, centerPublicKey);
      await audit.append({ outcome: "accepted", txHash: body.txHash, center: centerAddress });
      return reply.send(result);
    } catch (error) {
      const failure = error instanceof RequestFailure ? error : undefined;
      const errorCode = failure?.code ?? (error instanceof z.ZodError ? "invalid_request" : "request_verification_failed");
      try {
        const rejected: { outcome: "rejected"; errorCode: string; txHash?: string; center?: string } = {
          outcome: "rejected",
          errorCode,
        };
        if (txHash) rejected.txHash = txHash;
        if (centerAddress) rejected.center = centerAddress;
        await audit.append(rejected);
      } catch (auditError) {
        request.log.error({ name: auditError instanceof Error ? auditError.name : "unknown" }, "audit log append failed");
      }
      request.log.warn({ txHash, center: centerAddress, errorCode }, "key package request rejected");
      const statusCode = failure?.statusCode ?? (error instanceof z.ZodError ? 400 : 503);
      return reply.code(statusCode).send({ error: errorCode });
    }
  });

  app.get("/v1/audit-shares", async (_request, reply) => {
    if (Number(await contract.getFunction("phase")()) !== 4) {
      return reply.code(403).send({ error: "audit_shares_unavailable_until_exam_finalized" });
    }
    const total = Number(await contract.getFunction("totalSubmissions")());
    const entries = await Promise.all(Array.from({ length: total }, async (_, questionId) => ({
      questionId,
      share: Buffer.from(await loadQuestionShare(questionId)).toString("base64"),
    })));
    const unsigned = {
      chainId: config.CHAIN_ID,
      contract: contractAddress,
      shareIndex: config.KEY_SHARE_INDEX,
      entries,
    };
    const signature = await signer.signMessage(getBytes(keccak256(toUtf8Bytes(canonicalJson(unsigned)))));
    const result: AuditSharePackage = { ...unsigned, signature };
    return reply.send(result);
  });

  await app.listen({ host: "0.0.0.0", port: config.KEY_SERVICE_PORT });
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "unknown";
  console.error(`key-service startup failed: ${name}`);
  process.exitCode = 1;
});
