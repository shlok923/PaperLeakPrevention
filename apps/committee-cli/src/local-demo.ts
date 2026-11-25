import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import dotenv from "dotenv";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  NonceManager,
  JsonRpcProvider,
  type Signer,
  Wallet,
  getAddress,
  hexlify,
  keccak256,
  randomBytes,
  toUtf8Bytes,
  type InterfaceAbi,
} from "ethers";
import {
  encryptQuestion,
  generateCenterKeypair,
  generateX25519Keypair,
  sealShare,
  type QuestionPayload,
} from "@eplps/crypto";
import { createExamManager } from "@eplps/shared";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(root, ".env") });

const rpcUrl = "http://127.0.0.1:8545";
const apiUrl = "http://127.0.0.1:3000";
const logDir = path.join(root, ".keys/demo-local/logs");
const demoKeyDir = path.join(root, ".keys/demo-local");
const children: Array<{ name: string; child: ChildProcess }> = [];

type Role = "ADMIN" | "SUBMITTERS" | "SHAMIR KEYHOLDERS" | "RELAYER" | "CENTER";
type DemoWallet = { index: number; address: string; privateKey: string; role: Role };
type HolderKey = { publicKey: string; privateKey: string };
type BatchArtifact = {
  blob: Uint8Array;
  ciphertextHash: string;
  keyShareHashes: string[];
  plaintextCommitment: string;
  objectId: string;
  encryptedShares: Uint8Array[];
};

function fail(message: string): never {
  throw new Error(message);
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError})` : ""}`);
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function launch(name: string, command: string, args: string[], env = process.env): void {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const fd = openSync(path.join(logDir, `${name}.log`), "a", 0o600);
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  children.push({ name, child });
}

async function stopChildren(): Promise<void> {
  for (const { child } of [...children].reverse()) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child may already have exited.
    }
  }
  children.length = 0;
}

function readWallets(text: string): DemoWallet[] {
  const wallets: DemoWallet[] = [];
  let role: Role | undefined;
  let index: number | undefined;
  let address: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^--\s*(ADMIN|SUBMITTERS|SHAMIR KEYHOLDERS|RELAYER|CENTER)\s*--$/i.exec(line);
    if (heading) {
      role = heading[1]!.toUpperCase() as Role;
      index = undefined;
      address = undefined;
      continue;
    }
    const accountMatch = /^Account #(\d+):\s*(0x[0-9a-fA-F]{40})(?:\s|$)/.exec(line);
    if (accountMatch) {
      index = Number(accountMatch[1]);
      address = getAddress(accountMatch[2]!);
      continue;
    }
    const privateKeyMatch = /^Private Key:\s*(0x[0-9a-fA-F]{64})$/.exec(line);
    if (privateKeyMatch && role && index !== undefined && address) {
      const wallet = new Wallet(privateKeyMatch[1]!);
      if (getAddress(wallet.address) !== address) fail(`Wallet entry ${index} in docs/benchmarks.txt has a mismatched address/key pair`);
      wallets.push({ index, address, privateKey: privateKeyMatch[1]!, role });
      index = undefined;
      address = undefined;
    }
  }
  const expected: Record<Role, number> = {
    ADMIN: 1,
    SUBMITTERS: 9,
    "SHAMIR KEYHOLDERS": 5,
    RELAYER: 1,
    CENTER: 4,
  };
  for (const [name, count] of Object.entries(expected) as Array<[Role, number]>) {
    if (wallets.filter((item) => item.role === name).length !== count) {
      fail(`docs/benchmarks.txt must contain ${count} wallets in the ${name} section`);
    }
  }
  return wallets;
}

function byRole(wallets: DemoWallet[], role: Role): DemoWallet[] {
  return wallets.filter((wallet) => wallet.role === role).sort((a, b) => a.index - b.index);
}

async function updateEnvFile(file: string, values: Record<string, string>): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = await readFile(path.join(root, ".env.example"), "utf8");
  }
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, `${key}=${value}`);
    else text += `${text.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  await writeFile(file, text, { mode: 0o600 });
}

async function getHolderKeys(): Promise<HolderKey[]> {
  const result: HolderKey[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const filename = path.join(root, `.keys/key-holder-${index}.json`);
    let pair: HolderKey;
    try {
      pair = JSON.parse(await readFile(filename, "utf8")) as HolderKey;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pair.publicKey) || !/^0x[0-9a-fA-F]{64}$/.test(pair.privateKey)) {
        fail(`Invalid holder keypair file: ${path.relative(root, filename)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pair = await generateX25519Keypair();
      await writeFile(filename, `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600 });
      console.log(`Generated missing X25519 holder key ${index} at ${path.relative(root, filename)}`);
    }
    result.push(pair);
  }
  return result;
}

async function startRustFs(): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  if (await httpReady(endpoint)) return;
  try {
    execFileSync("docker", ["compose", "up", "-d"], { cwd: root, stdio: "inherit" });
  } catch {
    fail("Could not start RustFS with Docker. Start it with `docker compose up -d` (or `sudo docker compose up -d`), then rerun `npm run demo:local`.");
  }
  await waitUntil("RustFS", () => httpReady(endpoint), 60_000);
}

async function waitForChain(provider: JsonRpcProvider): Promise<void> {
  await waitUntil("local Hardhat chain", async () => {
    const network = await provider.getNetwork();
    return Number(network.chainId) === 31337;
  });
}

async function makeBatch(
  submitterIndex: number,
  subjectIndex: number,
  entityIndex: number,
  holderPublicKeys: string[],
): Promise<BatchArtifact[]> {
  const subjects = ["P", "C", "M"] as const;
  const subject = subjects[subjectIndex]!;
  const subjectNames = ["Physics", "Chemistry", "Maths"];
  const artifacts = await Promise.all(Array.from({ length: 50 }, async (_, questionIndex) => {
    const payload: QuestionPayload = {
      v: 1,
      subject,
      text: `LOCAL DEMO · ${subjectNames[subjectIndex]} · entity ${entityIndex + 1} · question ${questionIndex + 1}`,
      options: ["Demo option A", "Demo option B", "Demo option C", "Demo option D"],
      correct: questionIndex % 4,
    };
    const encrypted = await encryptQuestion(payload);
    const encryptedShares = await Promise.all(encrypted.keyShares.map((share, holderIndex) =>
      sealShare(holderPublicKeys[holderIndex]!, share.data)));
    return {
      blob: encrypted.blob,
      ciphertextHash: encrypted.ciphertextHash,
      keyShareHashes: encrypted.keyShareHashes,
      plaintextCommitment: encrypted.plaintextCommitment,
      objectId: encrypted.objectId,
      encryptedShares,
    };
  }));
  console.log(`Prepared 50 encrypted demo questions for submitter account #${submitterIndex}.`);
  return artifacts;
}

async function authorizeAndUpload(
  submitter: Signer,
  managerAddress: string,
  artifacts: BatchArtifact[],
): Promise<void> {
  const objectIds = artifacts.map((item) => item.objectId);
  const ciphertextHashes = artifacts.map((item) => item.ciphertextHash);
  const batchHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes16[]", "bytes32[]"],
    [objectIds, ciphertextHashes],
  ));
  const timestamp = Math.floor(Date.now() / 1000);
  const submitterAddress = await submitter.getAddress();
  const message = `EPLPS-UPLOAD-BATCH:31337:${managerAddress}:${submitterAddress}:${batchHash}:${timestamp}`;
  const signature = await submitter.signMessage(message);
  const authResponse = await fetch(`${apiUrl}/v1/submitters/${submitterAddress}/uploads/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objectIds, ciphertextHashes, timestamp, signature }),
  });
  if (!authResponse.ok) throw new Error(`Upload authorization failed for ${submitterAddress}: ${authResponse.status}`);
  const { uploadToken } = await authResponse.json() as { uploadToken: string };

  for (let offset = 0; offset < artifacts.length; offset += 5) {
    const group = artifacts.slice(offset, offset + 5);
    await Promise.all(group.map(async (artifact) => {
      const response = await fetch(`${apiUrl}/v1/submitters/${submitterAddress}/objects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadToken,
          objectId: artifact.objectId,
          ciphertextHash: artifact.ciphertextHash,
          dataBase64: Buffer.from(artifact.blob).toString("base64"),
        }),
      });
      if (!response.ok) throw new Error(`Ciphertext upload failed for ${artifact.objectId}: ${response.status}`);
    }));
  }
}

async function submitBatch(
  manager: Contract,
  submitter: Signer,
  managerAddress: string,
  artifacts: BatchArtifact[],
): Promise<void> {
  await authorizeAndUpload(submitter, managerAddress, artifacts);
  const batch = artifacts.map((item) => [
    item.ciphertextHash,
    item.keyShareHashes,
    item.plaintextCommitment,
    item.objectId,
    item.encryptedShares.map((share) => hexlify(share)),
  ]);
  const tx = await manager.connect(submitter).getFunction("submitQuestions")(batch);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Batch transaction failed for ${await submitter.getAddress()}`);
}

async function openCommitmentPhase(
  provider: JsonRpcProvider,
  manager: Contract,
  admin: Signer,
  committees: Signer[],
  relayer: Signer,
  commitAt: bigint,
  revealAt: bigint,
): Promise<void> {
  const closeTx = await manager.connect(admin).getFunction("closeSubmissions")();
  await closeTx.wait();
  const secrets = committees.map(() => hexlify(randomBytes(32)));
  for (let index = 0; index < committees.length; index += 1) {
    const wallet = committees[index]!;
    const commitment = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address"],
      [secrets[index]!, await wallet.getAddress()],
    ));
    const tx = await manager.connect(wallet).getFunction("commit")(commitment);
    await tx.wait();
  }

  await provider.send("evm_setNextBlockTimestamp", [Number(commitAt)]);
  for (let index = 0; index < committees.length; index += 1) {
    const tx = await manager.connect(committees[index]!).getFunction("reveal")(secrets[index]!);
    await tx.wait();
  }

  await provider.send("evm_setNextBlockTimestamp", [Number(revealAt)]);
  const entropy = randomBytes(32);
  const entropyValue = keccak256(entropy);
  const entropyTx = await manager.connect(relayer).getFunction("submitAnu")(entropyValue, entropy);
  await entropyTx.wait();
  const setsTx = await manager.connect(admin).getFunction("generateSets")();
  await setsTx.wait();
}

async function main(): Promise<void> {
  const benchmarkFile = path.join(root, "docs/benchmarks.txt");
  const wallets = readWallets(await readFile(benchmarkFile, "utf8"));
  const admins = byRole(wallets, "ADMIN");
  const submitters = byRole(wallets, "SUBMITTERS");
  const holderWallets = byRole(wallets, "SHAMIR KEYHOLDERS");
  const relayers = byRole(wallets, "RELAYER");
  const centers = byRole(wallets, "CENTER");

  await startRustFs();
  const busyPorts: number[] = [];
  for (const port of [8545, 3000, 3001, 3002, 3003, 3004, 3005, 5173, 5174, 5175]) {
    if (!await portIsFree(port)) busyPorts.push(port);
  }
  if (busyPorts.length) fail(`Stop existing local services first; these ports are busy: ${busyPorts.join(", ")}`);

  launch("hardhat", "npm", ["run", "dev:chain"]);
  const provider = new JsonRpcProvider(rpcUrl, 31337);
  await waitForChain(provider);
  const rpcAccounts = (await provider.send("eth_accounts", [])) as string[];
  for (const wallet of wallets) {
    if (getAddress(rpcAccounts[wallet.index] ?? "0x0000000000000000000000000000000000000000") !== wallet.address) {
      fail("docs/benchmarks.txt does not match the deterministic local Hardhat accounts; check the local chain configuration");
    }
  }

  const signer = (entry: DemoWallet) => new NonceManager(new Wallet(entry.privateKey, provider));
  const admin = signer(admins[0]!);
  const committee = holderWallets.map(signer);
  const relayer = signer(relayers[0]!);
  const submitterSigners = submitters.map(signer);
  const holderKeypairs = await getHolderKeys();
  const centerKeypairs = await Promise.all(centers.map(() => generateCenterKeypair()));
  mkdirSync(demoKeyDir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < centers.length; index += 1) {
    await writeFile(
      path.join(demoKeyDir, `center-${index + 1}.json`),
      `${JSON.stringify(centerKeypairs[index], null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  const artifactPath = path.join(root, "packages/contracts/artifacts/contracts/ExamManager.sol/ExamManager.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as { abi: InterfaceAbi; bytecode: string };
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, admin);
  const deployment = await factory.deploy(900, 1800);
  await deployment.waitForDeployment();
  const contractAddress = await deployment.getAddress();
  const manager = createExamManager(contractAddress, provider) as Contract;

  const latest = await provider.getBlock("latest");
  if (!latest) fail("Could not read the local chain timestamp");
  const baseTime = BigInt(latest.timestamp);
  const commitAt = baseTime + 30n * 24n * 3600n;
  const revealAt = baseTime + 31n * 24n * 3600n;
  const anuAt = revealAt + 600n;
  const shiftZeroStart = revealAt + 600n;
  // Keep demo shifts close together so each center flow can be exercised without a long wait.
  const demoShiftInterval = 15n * 60n;

  await (await manager.connect(admin).getFunction("registerCommittee")(
    await Promise.all(committee.map((item) => item.getAddress())),
  )).wait();
  await (await manager.connect(admin).getFunction("setKeyHolderPublicKeys")(holderKeypairs.map((item) => item.publicKey))).wait();
  await (await manager.connect(admin).getFunction("setRelayer")(relayers[0]!.address)).wait();
  for (let shiftId = 0; shiftId < 6; shiftId += 1) {
    const start = shiftZeroStart + BigInt(shiftId) * demoShiftInterval;
    await (await manager.connect(admin).getFunction("setShift")(shiftId, start, start + 1800n)).wait();
  }
  for (let index = 0; index < submitters.length; index += 1) {
    const subject = Math.floor(index / 3);
    const entity = index % 3;
    await (await manager.connect(admin).getFunction("registerSubmitter")(
      submitters[index]!.address,
      subject,
      entity,
    )).wait();
  }
  for (let index = 0; index < centers.length; index += 1) {
    await (await manager.connect(admin).getFunction("registerCenter")(
      centers[index]!.address,
      index,
      centerKeypairs[index]!.publicKey,
    )).wait();
  }
  await (await manager.connect(admin).getFunction("configureRandomness")(commitAt, revealAt, anuAt)).wait();
  await (await manager.connect(admin).getFunction("openSubmissions")()).wait();

  await updateEnvFile(path.join(root, ".env"), {
    CHAIN_ID: "31337",
    CHAIN_RPC_URL: rpcUrl,
    CHAIN_WS_URL: "ws://127.0.0.1:8545",
    CONTRACT_ADDRESS: contractAddress,
    API_PORT: "3000",
    RELAYER_PRIVATE_KEY: relayers[0]!.privateKey,
  });
  const deploymentRecord = {
    contract: "ExamManager",
    address: contractAddress,
    chainId: 31337,
    deployedAt: new Date().toISOString(),
    transactionHash: deployment.deploymentTransaction()?.hash ?? null,
  };
  await writeFile(
    path.join(root, "packages/contracts/deployments/31337.json"),
    `${JSON.stringify(deploymentRecord, null, 2)}\n`,
  );

  launch("api", "npm", ["run", "dev:api"], {
    ...process.env,
    CHAIN_ID: "31337",
    CHAIN_RPC_URL: rpcUrl,
    CONTRACT_ADDRESS: contractAddress,
    API_PORT: "3000",
  });
  await waitUntil("API health endpoint", () => httpReady(`${apiUrl}/health`));

  console.log(`Deployed a fresh local ExamManager at ${contractAddress}.`);
  console.log("Configured admin, committee/key holders, relayer, 9 submitters, 6 shifts, and 4 centers.");
  console.log("Auto-seeding 8 submitters. Physics/entity 1 is left for the submitter portal test.");
  for (let index = 1; index < submitterSigners.length; index += 1) {
    const subject = Math.floor(index / 3);
    const entity = index % 3;
    const artifacts = await makeBatch(submitters[index]!.index, subject, entity, holderKeypairs.map((item) => item.publicKey));
    await submitBatch(manager, submitterSigners[index]!, contractAddress, artifacts);
    console.log(`Seeded submitter ${index + 1}/9 · ${submitters[index]!.address} · 50 questions.`);
  }

  const apiEnv = {
    ...process.env,
    CHAIN_ID: "31337",
    CHAIN_RPC_URL: rpcUrl,
    CONTRACT_ADDRESS: contractAddress,
    API_PORT: "3000",
  };
  // Fresh demo deployments can reuse the same local contract address after Hardhat restarts.
  // Isolate cached holder packages per run so a prior exam's question IDs/shares cannot leak in.
  const packageCacheDir = `.keys/demo-local/packages/${hexlify(randomBytes(16)).slice(2)}`;
  for (let index = 0; index < holderWallets.length; index += 1) {
    launch(`key-holder-${index + 1}`, "npm", ["run", "dev:key-service"], {
      ...apiEnv,
      KEY_SHARE_INDEX: String(index + 1),
      KEY_SERVICE_PORT: String(3001 + index),
      KEY_SERVICE_SIGNER_PRIVATE_KEY: holderWallets[index]!.privateKey,
      KEY_SHARE_PRIVATE_KEY_FILE: `.keys/key-holder-${index + 1}.json`,
      KEY_PACKAGE_CACHE_DIR: packageCacheDir,
      KEY_SERVICE_AUDIT_FILE: `.keys/demo-local/key-holder-${index + 1}-audit.jsonl`,
    });
  }
  launch("admin-web", "npm", ["run", "dev:admin"]);
  launch("submitter-web", "npm", ["run", "dev:submitter"]);
  launch("center-web", "npm", ["run", "dev:center"]);

  await Promise.all([
    ...[3001, 3002, 3003, 3004, 3005].map((port) => waitUntil(`key-holder service on port ${port}`, () => httpReady(`http://127.0.0.1:${port}/health`))),
    waitUntil("admin portal", () => httpReady("http://127.0.0.1:5173")),
    waitUntil("submitter portal", () => httpReady("http://127.0.0.1:5174")),
    waitUntil("center portal", () => httpReady("http://127.0.0.1:5175")),
  ]);

  console.log("\nLocal demo services are running:");
  console.log("  Admin:     http://127.0.0.1:5173");
  console.log("  Submitter: http://127.0.0.1:5174");
  console.log("  Center:    http://127.0.0.1:5175");
  console.log(`  Center wallet: ${centers[0]!.address} · assigned shift 0`);
  console.log(`  Center private-key file: ${path.relative(root, path.join(demoKeyDir, "center-1.json"))}`);
  console.log(`  Admin wallet: ${admins[0]!.address}`);
  console.log(`  Submitter test wallet, Physics/entity 1: ${submitters[0]!.address}`);
  console.log(`  Contract address is in .env and ${path.relative(root, path.join(root, "packages/contracts/deployments/31337.json"))}.`);
  console.log(`  Service logs: ${path.relative(root, logDir)}/`);
  console.log("\nIn MetaMask, select the local chain 31337 and the Physics/entity 1 wallet.");
  console.log("Submit examples/questions-physics-entity-1.json. Expect one signature for the uploads and one batch transaction.");
  console.log("After that 50-question transaction confirms, this script automatically closes submissions, completes local randomness, and generates all 6 shift sets.");
  console.log("Once generation completes, use the center portal with the printed center wallet and key file. Its key window is open for the demo shift.");
  console.log("Press Ctrl+C to stop the local chain and demo services. RustFS data remains in its Docker volume.");

  const keepAlive = setInterval(() => undefined, 60_000);
  let finished = false;
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const count = Number(await manager.getFunction("submitterQuestionCount")(submitters[0]!.address));
    if (count === 50) finished = true;
  }
  console.log("\nFinal submitter batch detected on chain. Closing submissions and generating shift papers…");
  await openCommitmentPhase(provider, manager, admin, committee, relayer, commitAt, revealAt);
  const shiftZero = await manager.getFunction("shifts")(0);
  const keyOpenBefore = Number(await manager.getFunction("keyOpenBefore")());
  const shiftZeroWindowOpens = Number(shiftZero.startTime) - keyOpenBefore;
  const latestAfterGeneration = await provider.getBlock("latest");
  if (!latestAfterGeneration) fail("Could not read the local chain timestamp after generating papers");
  if (latestAfterGeneration.timestamp < shiftZeroWindowOpens) {
    await provider.send("evm_setNextBlockTimestamp", [shiftZeroWindowOpens]);
    await provider.send("evm_mine", []);
  }
  console.log("All 450 questions are committed; randomness is complete and the 6 shift sets are generated.");
  console.log("The local chain clock is at shift 0's key-release window; the center can request shares now.");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  clearInterval(keepAlive);
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await stopChildren();
  process.exitCode = 1;
});

process.once("SIGINT", () => {
  void stopChildren().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stopChildren().finally(() => process.exit(0));
});
