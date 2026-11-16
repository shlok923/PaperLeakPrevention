import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { Command } from "commander";
import { JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";
import { createExamManager } from "@eplps/shared";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

interface EntropyProvider {
  fetch1024Bytes(): Promise<Uint8Array>;
}

class AnuProvider implements EntropyProvider {
  constructor(private readonly url: string, private readonly apiKey: string) {}

  async fetch1024Bytes(): Promise<Uint8Array> {
    const response = await fetch(this.url, { headers: { "x-api-key": this.apiKey } });
    if (!response.ok) throw new Error(`ANU provider returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const candidate = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data)
        ? payload.data
        : typeof payload === "object" && payload !== null && "randomNumbers" in payload && Array.isArray(payload.randomNumbers)
          ? payload.randomNumbers
          : undefined;
    if (!candidate || candidate.length !== 1024 || candidate.some((value) => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255)) {
      throw new Error("ANU response must contain exactly 1024 uint8 values");
    }
    return Uint8Array.from(candidate as number[]);
  }
}

class LocalCsprngProvider implements EntropyProvider {
  async fetch1024Bytes(): Promise<Uint8Array> {
    console.warn("INSECURE_DEV: using local CSPRNG entropy instead of the ANU Quantum Numbers API");
    return new Uint8Array(randomBytes(1024));
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function makeProvider(name: string): EntropyProvider {
  if (name === "local") return new LocalCsprngProvider();
  if (name === "anu") return new AnuProvider(required("ANU_API_URL"), required("ANU_API_KEY"));
  throw new Error("provider must be either anu or local");
}

async function runRelayer(providerName: string): Promise<void> {
  const chainId = Number(required("CHAIN_ID"));
  const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"), chainId);
  const privateKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.ACTOR_PRIVATE_KEY;
  if (!privateKey) throw new Error("RELAYER_PRIVATE_KEY is required");
  const signer = new Wallet(privateKey, provider);
  const contract = createExamManager(getAddress(required("CONTRACT_ADDRESS")), signer);
  const relayerAddress: string = await contract.getFunction("relayer")();
  if (getAddress(relayerAddress) !== getAddress(signer.address)) throw new Error("wallet is not the registered ANU relayer");
  if (Number(await contract.getFunction("phase")()) !== 2) throw new Error("exam is not in the randomness phase");
  if (await contract.getFunction("anuSubmitted")()) {
    console.log("ANU value already submitted; nothing to do.");
    return;
  }

  const revealDeadline = Number(await contract.getFunction("revealDeadline")());
  const anuDeadline = Number(await contract.getFunction("anuDeadline")());
  let block = await provider.getBlock("latest");
  if (!block) throw new Error("latest chain block is unavailable");
  while (block.timestamp < revealDeadline) {
    const waitSeconds = Math.max(1, Math.min(5, revealDeadline - block.timestamp));
    console.log(`Waiting for reveal deadline (${new Date(revealDeadline * 1000).toISOString()}).`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    block = await provider.getBlock("latest");
    if (!block) throw new Error("latest chain block is unavailable");
  }
  if (block.timestamp >= anuDeadline) throw new Error("ANU window has closed; contract fallback will use zero entropy");

  const contractAddress = getAddress(required("CONTRACT_ADDRESS"));
  const entropyProvider = makeProvider(providerName);
  const rawFile = path.resolve(projectRoot, process.env.ENTROPY_RAW_FILE
    ?? `.keys/anu-raw-${chainId}-${contractAddress.toLowerCase()}.bin`);
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await readFile(rawFile));
    if (raw.length !== 1024) throw new Error("saved ANU raw input must be exactly 1024 bytes");
    console.log(`Reusing saved entropy input at ${rawFile}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = await entropyProvider.fetch1024Bytes();
    if (raw.length !== 1024) throw new Error("entropy provider returned an invalid byte count");
    await mkdir(path.dirname(rawFile), { recursive: true });
    await writeFile(rawFile, raw, { mode: 0o600, flag: "wx" });
  }

  block = await provider.getBlock("latest");
  if (!block || block.timestamp < revealDeadline || block.timestamp >= anuDeadline) {
    throw new Error("ANU window changed while entropy was fetched; raw input is saved for operator review");
  }
  const value = keccak256(raw);
  const tx = await contract.getFunction("submitAnu")(value, raw);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("ANU submission transaction failed");
  console.log(`ANU value submitted in ${receipt.hash}; raw input remains at ${rawFile}.`);
}

const program = new Command("eplps-anu-relayer")
  .description("Wait for the reveal deadline, fetch one entropy value, and submit it on-chain")
  .option("--provider <name>", "entropy provider: anu or local", process.env.ENTROPY_PROVIDER ?? "anu");

program.action(async (options: { provider: string }) => runRelayer(options.provider));
await program.parseAsync(process.argv);
