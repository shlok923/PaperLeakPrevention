import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { Command } from "commander";
import { AbiCoder, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";
import { generateX25519Keypair } from "@eplps/crypto";
import { createExamManager } from "@eplps/shared";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function actor(): { provider: JsonRpcProvider; signer: Wallet; contract: ReturnType<typeof createExamManager>; secretFile: string } {
  const chainId = Number(required("CHAIN_ID"));
  const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"), chainId);
  const privateKey = process.env.COMMITTEE_PRIVATE_KEY?.trim() || process.env.ACTOR_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("COMMITTEE_PRIVATE_KEY is required");
  const normalizedPrivateKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedPrivateKey)) {
    throw new Error("COMMITTEE_PRIVATE_KEY must be a 32-byte Ethereum private key (0x followed by 64 hex characters), not a wallet address or seed phrase");
  }
  let signer: Wallet;
  try {
    signer = new Wallet(normalizedPrivateKey, provider);
  } catch {
    throw new Error("COMMITTEE_PRIVATE_KEY is not a valid Ethereum private key; check that it is copied from the intended local account");
  }
  const contractAddress = getAddress(required("CONTRACT_ADDRESS"));
  const contract = createExamManager(contractAddress, signer);
  const keysDir = path.resolve(projectRoot, process.env.DEV_KEYS_DIR ?? ".keys");
  return { provider, signer, contract, secretFile: path.join(keysDir, `committee-${signer.address.toLowerCase()}.secret`) };
}

async function commitSecret(): Promise<void> {
  const { signer, contract, secretFile } = actor();
  const alreadyCommitted: boolean = await contract.getFunction("hasCommitted")(signer.address);
  let secret: string;
  try {
    secret = (await readFile(secretFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || alreadyCommitted) {
      if (alreadyCommitted && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("commit is already on-chain but the matching local secret file is missing");
      }
      throw error;
    }
    await mkdir(path.dirname(secretFile), { recursive: true });
    secret = `0x${randomBytes(32).toString("hex")}`;
    await writeFile(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error("stored committee secret is malformed");
  if (alreadyCommitted) {
    console.log(`Commit already recorded for ${signer.address}; secret remains in ${secretFile}`);
    return;
  }
  const commitment = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "address"], [secret, signer.address]));
  const tx = await contract.getFunction("commit")(commitment);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("committee commitment transaction failed");
  console.log(`Commit recorded for ${signer.address} in ${receipt.hash}. Secret stored locally at ${secretFile}.`);
}

async function revealSecret(): Promise<void> {
  const { signer, contract, secretFile } = actor();
  const secret = (await readFile(secretFile, "utf8")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error("stored committee secret is malformed");
  const alreadyRevealed: boolean = await contract.getFunction("hasRevealed")(signer.address);
  if (alreadyRevealed) {
    console.log(`Reveal already recorded for ${signer.address}.`);
    return;
  }
  const tx = await contract.getFunction("reveal")(secret);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("committee reveal transaction failed");
  console.log(`Reveal recorded for ${signer.address} in ${receipt.hash}.`);
}

async function generateShareHolderKey(): Promise<void> {
  const { signer, contract } = actor();
  let shareIndex = 0;
  for (let index = 0; index < 5; index += 1) {
    const registered: string = await contract.getFunction("committee")(index);
    if (getAddress(registered) === getAddress(signer.address)) shareIndex = index + 1;
  }
  if (shareIndex === 0) throw new Error("Connected wallet is not a registered committee/key-share holder");
  const keysDir = path.resolve(projectRoot, process.env.DEV_KEYS_DIR ?? ".keys");
  const keyFile = path.join(keysDir, `key-holder-${shareIndex}.json`);
  await mkdir(keysDir, { recursive: true });
  let pair: { publicKey: string; privateKey: string };
  try {
    pair = JSON.parse(await readFile(keyFile, "utf8")) as typeof pair;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    pair = await generateX25519Keypair();
    await writeFile(keyFile, `${JSON.stringify(pair, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pair.publicKey) || !/^0x[0-9a-fA-F]{64}$/.test(pair.privateKey)) {
    throw new Error("Stored holder key file is malformed");
  }
  const onChainKeyRegistered: boolean = await contract.getFunction("keyHolderKeysRegistered")();
  if (onChainKeyRegistered) {
    const registeredKey: string = await contract.getFunction("keyHolderPublicKeys")(shareIndex - 1);
    if (registeredKey.toLowerCase() !== pair.publicKey.toLowerCase()) {
      throw new Error("Stored public key differs from the key registered on-chain; do not replace the private key");
    }
  }
  console.log(`Share holder ${shareIndex} X25519 public key: ${pair.publicKey}`);
  console.log(`Private key file: ${keyFile}`);
}

const program = new Command("eplps-committee").description("Commit and reveal a committee randomness contribution");
program.command("gen-share-key").description("Generate or display this holder's X25519 share-encryption key").action(generateShareHolderKey);
program.command("commit").description("Create or resume the local commitment").action(commitSecret);
program.command("reveal").description("Reveal the locally stored secret").action(revealSecret);

await program.parseAsync(process.argv);
