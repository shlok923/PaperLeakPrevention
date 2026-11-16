import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Command } from "commander";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AbiCoder,
  JsonRpcProvider,
  getBytes,
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";
import { canonicalJson, combineQuestionKeyShares, computeSeed, decryptQuestion, slicePools } from "@eplps/crypto";
import { createExamManager } from "@eplps/shared";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

type Check = { name: string; passed: boolean; detail: string };
type AuditReport = { chainId: number; contract: string; checkedAt: string; checks: Check[]; failures: string[] };
type EventRecord = { name: string; args: Record<string, unknown>; blockNumber: number; logIndex: number; txHash: string };
type SubmissionRecord = {
  submitter: string;
  subject: bigint;
  entity: bigint;
  submittedAt: bigint;
  ciphertextHash: string;
  keyShareHashes: readonly string[];
  plaintextCommitment: string;
  objectId: string;
};
type AuditSharePackage = {
  chainId: number;
  contract: string;
  shareIndex: number;
  entries: Array<{ questionId: number; share: string }>;
  signature: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readObject(s3: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`object not found: ${key}`);
  return new Uint8Array(await response.Body.transformToByteArray());
}

async function audit(): Promise<AuditReport> {
  const chainId = Number(required("CHAIN_ID"));
  const contractAddress = getAddress(required("CONTRACT_ADDRESS"));
  const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"), chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) throw new Error("configured CHAIN_ID does not match RPC network");
  const contract = createExamManager(contractAddress, provider);
  const report: AuditReport = {
    chainId,
    contract: contractAddress,
    checkedAt: new Date().toISOString(),
    checks: [],
    failures: [],
  };
  const check = (name: string, passed: boolean, detail: string) => {
    report.checks.push({ name, passed, detail });
    if (!passed) report.failures.push(`${name}: ${detail}`);
  };

  const logs = await provider.getLogs({ address: contractAddress, fromBlock: 0, toBlock: "latest" });
  const events: EventRecord[] = [];
  for (const log of logs) {
    const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed) events.push({ name: parsed.name, args: parsed.args as unknown as Record<string, unknown>, blockNumber: log.blockNumber, logIndex: log.index, txHash: log.transactionHash });
  }

  const totalSubmissions = Number(await contract.getFunction("totalSubmissions")());
  const submissionEvents = events.filter((event) => event.name === "QuestionSubmitted");
  const submissions = await Promise.all(Array.from({ length: totalSubmissions }, async (_, id) =>
    await contract.getFunction("getSubmission")(id) as SubmissionRecord));
  const ids = new Set<number>();
  let eventRecordsMatch = submissionEvents.length === totalSubmissions;
  for (const event of submissionEvents) {
    const id = Number(event.args.id);
    if (id < 0 || id >= submissions.length || ids.has(id)) {
      eventRecordsMatch = false;
      continue;
    }
    ids.add(id);
    const stored = submissions[id]!;
    eventRecordsMatch &&= getAddress(String(event.args.submitter)) === getAddress(stored.submitter)
      && Number(event.args.subject) === Number(stored.subject)
      && Number(event.args.entity) === Number(stored.entity)
      && String(event.args.ciphertextHash).toLowerCase() === stored.ciphertextHash.toLowerCase()
      && String(event.args.objectId).toLowerCase() === stored.objectId.toLowerCase();
  }
  check("submission event replay", eventRecordsMatch && ids.size === totalSubmissions, `${submissionEvents.length} events for ${totalSubmissions} stored submissions`);
  check("submission quota total", totalSubmissions === 450, `stored submission count is ${totalSubmissions}; expected 450`);

  const submitterAddresses = new Set<string>();
  let allPoolsComplete = true;
  const poolMatrix: number[][][] = [];
  for (let subject = 0; subject < 3; subject += 1) {
    const subjectPools: number[][] = [];
    for (let entity = 0; entity < 3; entity += 1) {
      const account = getAddress(await contract.getFunction("submitterForSlot")(subject, entity));
      submitterAddresses.add(account.toLowerCase());
      const count = Number(await contract.getFunction("submitterQuestionCount")(account));
      const pool = await contract.getFunction("getPool")(subject, entity) as readonly (bigint | number)[];
      allPoolsComplete &&= count === 50 && pool.length === 50;
      subjectPools.push(pool.map(Number));
    }
    poolMatrix.push(subjectPools);
  }
  check("submitter slots and quotas", allPoolsComplete && submitterAddresses.size === 9, `registered ${submitterAddresses.size} unique submitters; each slot has a 50-question pool`);

  const phase = Number(await contract.getFunction("phase")());
  const generated = phase >= 3;
  const anuSubmitted = Boolean(await contract.getFunction("anuSubmitted")());
  const anuValue: string = anuSubmitted ? await contract.getFunction("anuValue")() : `0x${"00".repeat(32)}`;
  const anuEvents = events.filter((event) => event.name === "AnuSubmitted");
  let anuValid = anuEvents.length === (anuSubmitted ? 1 : 0);
  if (anuEvents.length === 1) {
    const eventValue = String(anuEvents[0]!.args.value);
    const raw = String(anuEvents[0]!.args.raw);
    anuValid &&= keccak256(raw) === eventValue && eventValue.toLowerCase() === anuValue.toLowerCase();
  }
  check("ANU entropy event", anuValid, anuSubmitted ? "on-chain entropy hash matches the raw event value" : "ANU entropy was not submitted; zero fallback is configured");

  const revealEvents = events.filter((event) => event.name === "Revealed");
  const secrets = new Map<string, string>();
  let revealTransactionsValid = true;
  for (const event of revealEvents) {
    const member = getAddress(String(event.args.member));
    const transaction = await provider.getTransaction(event.txHash);
    if (!transaction) {
      revealTransactionsValid = false;
      continue;
    }
    const parsed = contract.interface.parseTransaction({ data: transaction.data, value: transaction.value });
    if (parsed?.name !== "reveal") {
      revealTransactionsValid = false;
      continue;
    }
    const secret = String(parsed.args.secret);
    const committed: string = await contract.getFunction("commitments")(member);
    const expected = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [secret, member]));
    revealTransactionsValid &&= expected.toLowerCase() === committed.toLowerCase();
    secrets.set(member.toLowerCase(), secret);
  }
  check("committee reveal commitments", revealTransactionsValid && revealEvents.length >= 3, `${revealEvents.length} revealed secrets match their on-chain commitments`);

  let derivedSeed = anuValue;
  const orderedReveals: Array<{ member: string; secret: string }> = [];
  for (let i = 0; i < 5; i += 1) {
    const member = getAddress(await contract.getFunction("committee")(i));
    const secret = secrets.get(member.toLowerCase());
    if (secret) orderedReveals.push({ member, secret });
  }
  derivedSeed = computeSeed(derivedSeed, orderedReveals);
  if (generated) {
    const storedSeed: string = await contract.getFunction("seed")();
    const generatedEvents = events.filter((event) => event.name === "SetsGenerated");
    const generationEventMatches = generatedEvents.length === 1
      && String(generatedEvents[0]!.args.seed).toLowerCase() === storedSeed.toLowerCase()
      && Boolean(generatedEvents[0]!.args.anuUsed) === anuSubmitted;
    check("seed derivation", derivedSeed.toLowerCase() === storedSeed.toLowerCase() && generationEventMatches, `recomputed ${derivedSeed}, stored ${storedSeed}`);

    const expectedShifts = slicePools(derivedSeed, poolMatrix);
    const seen = new Set<number>();
    let papersMatch = true;
    let distributionsValid = true;
    for (let shiftId = 0; shiftId < 6; shiftId += 1) {
      const actual = (await contract.getFunction("getShiftQuestions")(shiftId) as readonly (bigint | number)[]).map(Number);
      papersMatch &&= JSON.stringify(actual) === JSON.stringify(expectedShifts[shiftId]);
      if (actual.length !== 75) distributionsValid = false;
      const subjectCounts = [0, 0, 0];
      const entityCounts = Array.from({ length: 3 }, () => [0, 0, 0]);
      for (const id of actual) {
        if (seen.has(id)) distributionsValid = false;
        seen.add(id);
        const submission = submissions[id];
        if (!submission) {
          distributionsValid = false;
          continue;
        }
        const subject = Number(submission.subject);
        const entity = Number(submission.entity);
        subjectCounts[subject] = (subjectCounts[subject] ?? 0) + 1;
        entityCounts[subject]![entity] = (entityCounts[subject]![entity] ?? 0) + 1;
      }
      distributionsValid &&= subjectCounts.every((count) => count === 25);
      for (let subject = 0; subject < 3; subject += 1) {
        for (let entity = 0; entity < 3; entity += 1) {
          const expected = entity === shiftId % 3 ? 9 : 8;
          distributionsValid &&= entityCounts[subject]![entity] === expected;
        }
      }
    }
    check("deterministic paper generation", papersMatch, "all six on-chain question lists match TypeScript recomputation");
    check("disjoint 9/8/8 shift allocation", distributionsValid && seen.size === 450, `${seen.size} unique question IDs assigned across six papers`);
  } else {
    check("paper generation", false, "sets have not been generated yet");
  }

  const requestEvents = events.filter((event) => event.name === "KeyRequested");
  const keyOpenBefore = Number(await contract.getFunction("keyOpenBefore")());
  const keyCloseAfter = Number(await contract.getFunction("keyCloseAfter")());
  let requestsValid = true;
  const requestProblems: string[] = [];
  for (const event of requestEvents) {
    const center = getAddress(String(event.args.center));
    const shiftId = Number(event.args.shiftId);
    const [block, shiftAtRequest] = await Promise.all([
      provider.getBlock(event.blockNumber),
      contract.getFunction("shifts")(shiftId, { blockTag: event.blockNumber }),
    ]);
    const priorCenterEvents = events.filter((candidate) => {
      if (candidate.name !== "CenterRegistered" && candidate.name !== "CenterRevoked") return false;
      if (getAddress(String(candidate.args.center)).toLowerCase() !== center.toLowerCase()) return false;
      return candidate.blockNumber < event.blockNumber
        || (candidate.blockNumber === event.blockNumber && candidate.logIndex < event.logIndex);
    }).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    const registration = priorCenterEvents.filter((candidate) => candidate.name === "CenterRegistered").at(-1);
    const revokedBeforeRequest = priorCenterEvents.some((candidate) => candidate.name === "CenterRevoked");
    const inWindow = !!block
      && block.timestamp >= Number(shiftAtRequest.startTime) - keyOpenBefore
      && block.timestamp <= Number(shiftAtRequest.startTime) + keyCloseAfter;
    const eligible = !!registration && !revokedBeforeRequest && Number(registration.args.shiftId) === shiftId;
    if (!inWindow || !eligible) {
      requestsValid = false;
      requestProblems.push(`${center} shift ${shiftId} at block ${event.blockNumber}`);
    }
  }
  check("center key-request windows", requestsValid, requestProblems.length ? requestProblems.join(", ") : `${requestEvents.length} request events are within eligible windows`);

  if (phase === 4) {
    const s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
        secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
      },
    });
    const bucket = process.env.S3_BUCKET || `eplps-${chainId}-${contractAddress.toLowerCase()}`;
    const holderUrls = (process.env.KEY_HOLDER_URLS?.split(",").map((url) => url.trim()).filter(Boolean))
      ?? [1, 2, 3, 4, 5].map((index) => `http://127.0.0.1:${3000 + index}`);
    const holderResponses = await Promise.all(holderUrls.map(async (url) => {
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/v1/audit-shares`);
        if (!response.ok) return null;
        return await response.json() as AuditSharePackage;
      } catch {
        return null;
      }
    }));
    const validHolderPackages: AuditSharePackage[] = [];
    for (const pkg of holderResponses) {
      if (!pkg || pkg.chainId !== chainId || getAddress(pkg.contract) !== contractAddress
        || !Number.isInteger(pkg.shareIndex) || pkg.shareIndex < 1 || pkg.shareIndex > 5
        || pkg.entries.length !== submissions.length) continue;
      const { signature, ...unsigned } = pkg;
      const recovered = getAddress(verifyMessage(getBytes(keccak256(toUtf8Bytes(canonicalJson(unsigned)))), signature));
      const expectedHolder: string = await contract.getFunction("committee")(pkg.shareIndex - 1);
      if (recovered === getAddress(expectedHolder)) validHolderPackages.push(pkg);
    }
    const selectedHolderPackages = validHolderPackages.slice(0, 3);
    check("post-exam threshold holder responses", selectedHolderPackages.length >= 3,
      `${selectedHolderPackages.length} valid signed share packages; at least 3 are required`);
    let decryptedCount = 0;
    let allCiphertextValid = true;
    let allPlaintextValid = true;
    for (let id = 0; id < submissions.length && selectedHolderPackages.length >= 3; id += 1) {
      const submission = submissions[id]!;
      const objectId = submission.objectId.toLowerCase().replace(/^0x/, "");
      const blob = await readObject(s3, bucket, `${objectId}.ct`);
      const keyShares = selectedHolderPackages.map((pkg) => {
        const entry = pkg.entries.find((item) => item.questionId === id);
        if (!entry) throw new Error(`holder ${pkg.shareIndex} omitted question ${id}`);
        const data = Uint8Array.from(Buffer.from(entry.share, "base64"));
        return { index: pkg.shareIndex, data };
      });
      const sharesMatch = submission.keyShareHashes.length === 5 && keyShares.every((share) =>
        keccak256(share.data).toLowerCase() === submission.keyShareHashes[share.index - 1]?.toLowerCase());
      allCiphertextValid &&= keccak256(blob).toLowerCase() === submission.ciphertextHash.toLowerCase() && sharesMatch;
      try {
        const questionKey = combineQuestionKeyShares(keyShares.slice(0, 3));
        const opened = await decryptQuestion(blob, questionKey, submission.objectId);
        allPlaintextValid &&= keccak256(opened.envelope).toLowerCase() === submission.plaintextCommitment.toLowerCase();
        decryptedCount += 1;
      } catch {
        allPlaintextValid = false;
      }
    }
    check("stored ciphertext and Shamir key-share commitments", allCiphertextValid, `${submissions.length} ciphertexts and five shares per question checked`);
    check("post-exam plaintext commitments and schemas", allPlaintextValid && decryptedCount === submissions.length, `${decryptedCount} of ${submissions.length} questions decrypted and validated`);
  } else {
    check("post-exam decryption", false, "exam has not been finalized; full plaintext audit is not yet possible");
  }

  return report;
}

const program = new Command("eplps-auditor").description("Read-only EPLPS on-chain and object-store audit");
program.command("verify")
  .option("--json <file>", "write JSON report to a file")
  .action(async (options: { json?: string }) => {
    try {
      const report = await audit();
      const summary = report.checks.map((item) => `${item.passed ? "PASS" : "FAIL"} ${item.name}: ${item.detail}`).join("\n");
      console.log(summary);
      if (options.json) {
        const file = path.resolve(projectRoot, options.json);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
      if (report.failures.length) process.exitCode = 1;
    } catch (error) {
      console.error(`audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
