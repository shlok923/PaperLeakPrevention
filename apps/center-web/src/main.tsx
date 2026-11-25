import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserProvider,
  Contract,
  getAddress,
  getBytes,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";
import { canonicalJson, centerOrder, combineQuestionKeyShares, decryptQuestion, generateCenterKeypair, unsealShare, validatePayload } from "@eplps/crypto";
import { createExamManager } from "@eplps/shared";
import "./style.css";

type CenterManifest = {
  chainId: number;
  contract: string;
  center: string;
  shiftId: number;
  centerPublicKey: string;
  questions: Array<{
    questionId: number;
    objectId: string;
    ciphertextHash: string;
    keyShareHashes: string[];
    plaintextCommitment: string;
    ciphertextUrl: string;
  }>;
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
type CenterKeyFile = { publicKey: string; privateKey: string };
type DecryptedQuestion = ReturnType<typeof validatePayload> & { questionId: number };
type InjectedWallet = ConstructorParameters<typeof BrowserProvider>[0] & {
  on?: (event: "accountsChanged", listener: (accounts: string[]) => void) => void;
  removeListener?: (event: "accountsChanged", listener: (accounts: string[]) => void) => void;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const KEY_HOLDER_PATHS = [1, 2, 3, 4, 5].map((index) => `/key-holder-${index}`);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function downloadFile(name: string, type: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function makePrintablePaper(center: string, shiftId: number, questions: readonly DecryptedQuestion[]): string {
  const subjectNames = { P: "Physics", C: "Chemistry", M: "Mathematics" } as const;
  const rows = questions.map((question, index) => `
    <article class="question">
      <h2>${index + 1}. ${escapeHtml(question.text)}</h2>
      ${question.images?.map((image) => `<img class="question-image" src="data:${escapeHtml(image.mime)};base64,${image.dataBase64}" alt="${escapeHtml(image.name)}">`).join("") ?? ""}
      <ol type="A">${question.options.map((option) => `<li>${escapeHtml(option)}</li>`).join("")}</ol>
      <small>${subjectNames[question.subject]}</small>
    </article>`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>EPLPS Shift ${shiftId} Paper</title>
<style>
body{font:12pt/1.45 Arial,sans-serif;color:#111;margin:20mm}h1{font-size:18pt}.question{break-inside:avoid;margin:0 0 9mm}.question h2{font-size:12pt;font-weight:600}.question ol{margin-top:3mm}.question li{padding:1mm 0}
@media print{body{margin:18mm 16mm 20mm}footer{position:fixed;bottom:-12mm;left:0;right:0;border-top:1px solid #777;padding-top:2mm;font-size:9pt}}
</style></head><body><h1>Exam Paper · Shift ${shiftId}</h1>${rows}<footer>Shift ${shiftId} · Center ${escapeHtml(center)}</footer></body></html>`;
}

function CenterApp() {
  const [signer, setSigner] = useState<Awaited<ReturnType<BrowserProvider["getSigner"]>> | null>(null);
  const [manager, setManager] = useState<Contract | null>(null);
  const [account, setAccount] = useState("");
  const [manifest, setManifest] = useState<CenterManifest | null>(null);
  const [centerKey, setCenterKey] = useState<CenterKeyFile | null>(null);
  const [generatedKey, setGeneratedKey] = useState<CenterKeyFile | null>(null);
  const [ciphertexts, setCiphertexts] = useState<Map<number, Uint8Array>>(new Map());
  const [paper, setPaper] = useState<DecryptedQuestion[] | null>(null);
  const [chainTimestamp, setChainTimestamp] = useState<number | null>(null);
  const [releaseWindow, setReleaseWindow] = useState<{ opensAt: number; closesAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Connect your registered center wallet to begin.");

  useEffect(() => {
    if (!manager || !manifest || !signer) {
      setChainTimestamp(null);
      setReleaseWindow(null);
      return;
    }
    let active = true;
    const updateChainTime = async () => {
      const block = await signer.provider.getBlock("latest");
      if (active && block) setChainTimestamp(block.timestamp);
    };
    void (async () => {
      try {
        const [shift, openBefore, closeAfter] = await Promise.all([
          manager.getFunction("shifts")(manifest.shiftId),
          manager.getFunction("keyOpenBefore")(),
          manager.getFunction("keyCloseAfter")(),
        ]);
        if (active) {
          setReleaseWindow({
            opensAt: Number(shift.startTime) - Number(openBefore),
            closesAt: Number(shift.startTime) + Number(closeAfter),
          });
        }
        await updateChainTime();
      } catch {
        if (active) setReleaseWindow(null);
      }
    })();
    const timer = window.setInterval(() => void updateChainTime().catch(() => undefined), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [manager, manifest, signer]);

  useEffect(() => {
    const ethereum = (window as Window & { ethereum?: InjectedWallet }).ethereum;
    if (!ethereum?.on) return;
    const handleAccountsChanged = (accounts: string[]) => {
      setSigner(null);
      setManager(null);
      setAccount("");
      setManifest(null);
      setCenterKey(null);
      setCiphertexts(new Map());
      setPaper(null);
      setChainTimestamp(null);
      setReleaseWindow(null);
      setStatus(accounts.length
        ? "Wallet account changed. Connect the selected registered center wallet."
        : "Wallet disconnected. Connect a registered center wallet to continue.");
    };
    ethereum.on("accountsChanged", handleAccountsChanged);
    return () => ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
  }, []);

  function disconnectWallet(): void {
    setSigner(null);
    setManager(null);
    setAccount("");
    setManifest(null);
    setCenterKey(null);
    setCiphertexts(new Map());
    setPaper(null);
    setChainTimestamp(null);
    setReleaseWindow(null);
    setStatus("Disconnected from this center session. Select another wallet in MetaMask, then connect again.");
  }

  async function switchWallet(): Promise<void> {
    const ethereum = (window as Window & { ethereum?: InjectedWallet }).ethereum;
    if (!ethereum) throw new Error("No EVM wallet was found in this browser");
    const browserProvider = new BrowserProvider(ethereum);
    try {
      await browserProvider.send("wallet_revokePermissions", [{ eth_accounts: {} }]);
    } catch {
      await browserProvider.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
    }
    await browserProvider.send("eth_requestAccounts", []);
    await connectWallet();
  }

  async function connectWallet(): Promise<void> {
    const ethereum = (window as Window & { ethereum?: InjectedWallet }).ethereum;
    if (!ethereum) throw new Error("No EVM wallet was found in this browser");
    const browserProvider = new BrowserProvider(ethereum);
    await browserProvider.send("eth_requestAccounts", []);
    const walletSigner = await browserProvider.getSigner();
    const address = getAddress(await walletSigner.getAddress());
    const chain = await browserProvider.getNetwork();
    const configResponse = await responseJson<{ chainId: number; contract: string }>(await fetch(`${API_BASE}/v1/status`));
    if (Number(chain.chainId) !== configResponse.chainId) throw new Error(`Wallet is on chain ${chain.chainId}; expected ${configResponse.chainId}`);
    const contract = createExamManager(configResponse.contract, browserProvider) as Contract;
    const registration = await contract.getFunction("centers")(address);
    if (!registration.registered || registration.revoked) throw new Error("This wallet is not an active registered center");
    const centerManifest = await responseJson<CenterManifest>(await fetch(`${API_BASE}/v1/centers/${address}/manifest`));
    setSigner(walletSigner);
    setManager(createExamManager(configResponse.contract, walletSigner) as Contract);
    setAccount(address);
    setManifest(centerManifest);
    setStatus(`Connected to shift ${centerManifest.shiftId}. Fetch and verify ciphertexts before the key window.`);
  }

  async function importCenterKey(file?: File): Promise<void> {
    if (!file || !manifest) return;
    const parsed = JSON.parse(await file.text()) as CenterKeyFile;
    if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.publicKey) || !/^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)) {
      throw new Error("Center key file must contain 32-byte publicKey and privateKey hex values");
    }
    if (parsed.publicKey.toLowerCase() !== manifest.centerPublicKey.toLowerCase()) {
      throw new Error("This key file does not match the center public key registered on-chain");
    }
    setCenterKey(parsed);
    setStatus("Center private key loaded in this browser session.");
  }

  async function generateCenterKey(): Promise<void> {
    const pair = await generateCenterKeypair();
    setGeneratedKey(pair);
    downloadFile(
      "eplps-center-key.json",
      "application/json",
      JSON.stringify({ publicKey: pair.publicKey, privateKey: pair.privateKey }, null, 2),
    );
    setStatus("Center key file downloaded. Share only the public key for registration; keep the private key file with the center.");
  }

  async function fetchCiphertexts(): Promise<void> {
    if (!manifest) throw new Error("Connect a registered center first");
    setBusy(true);
    try {
      const fetched = new Map<number, Uint8Array>();
      await Promise.all(manifest.questions.map(async (question) => {
        const response = await fetch(`${API_BASE}${question.ciphertextUrl}`);
        if (!response.ok) throw new Error(`Question ${question.questionId}: ciphertext download failed`);
        const blob = new Uint8Array(await response.arrayBuffer());
        if (keccak256(blob) !== question.ciphertextHash) throw new Error(`Question ${question.questionId}: ciphertext hash mismatch`);
        fetched.set(question.questionId, blob);
      }));
      setCiphertexts(fetched);
      setStatus(`Downloaded and verified ${fetched.size} encrypted question blobs. No keys were requested.`);
    } finally {
      setBusy(false);
    }
  }

  async function requestAndBuildPaper(): Promise<void> {
    if (!manifest || !manager || !signer || !centerKey) throw new Error("Connect the center wallet and import its key file first");
    if (ciphertexts.size !== 75) throw new Error("Fetch and verify all 75 ciphertexts before requesting keys");
    setBusy(true);
    try {
      const shiftState = await manager.getFunction("shifts")(manifest.shiftId);
      const keyOpenBefore = Number(await manager.getFunction("keyOpenBefore")());
      const keyCloseAfter = Number(await manager.getFunction("keyCloseAfter")());
      const latestBlock = await signer.provider.getBlock("latest");
      if (!latestBlock) throw new Error("Could not read the latest chain timestamp");
      const now = latestBlock.timestamp;
      const opensAt = Number(shiftState.startTime) - keyOpenBefore;
      const closesAt = Number(shiftState.startTime) + keyCloseAfter;
      if (now < opensAt || now > closesAt) {
        const formatTime = (timestamp: number) => new Date(timestamp * 1000).toISOString();
        throw new Error(
          `This shift is outside its key-release window. Chain time: ${formatTime(now)}; `
          + `window: ${formatTime(opensAt)} to ${formatTime(closesAt)} (UTC).`,
        );
      }

      const transaction = await manager.getFunction("requestKeys")();
      const receipt = await transaction.wait();
      if (!receipt?.hash) throw new Error("Key request transaction did not confirm");
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `EPLPS-KEYREQ:${manifest.chainId}:${manifest.contract}:${receipt.hash}:${timestamp}`;
      const signature = await signer.signMessage(message);
      const holderResults = await Promise.all(KEY_HOLDER_PATHS.map(async (holderPath, offset) => {
        try {
          const keyPackage = await responseJson<KeyPackage>(await fetch(`${holderPath}/v1/package`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ txHash: receipt.hash, timestamp, signature }),
          }));
          const expectedIndex = offset + 1;
          if (keyPackage.chainId !== manifest.chainId || getAddress(keyPackage.contract) !== getAddress(manifest.contract)
            || keyPackage.shiftId !== manifest.shiftId || getAddress(keyPackage.center) !== getAddress(account)
            || keyPackage.shareIndex !== expectedIndex || keyPackage.entries.length !== 75) {
            throw new Error(`Share holder ${expectedIndex} returned an invalid package`);
          }
          const { signature: packageSignature, ...unsignedPackage } = keyPackage;
          const recoveredSigner = verifyMessage(
            getBytes(keccak256(toUtf8Bytes(canonicalJson(unsignedPackage)))),
            packageSignature,
          );
          const registeredHolder: string = await manager.getFunction("committee")(expectedIndex - 1);
          if (getAddress(recoveredSigner) !== getAddress(registeredHolder)) {
            throw new Error(`Share holder ${expectedIndex} signature is invalid`);
          }
          return keyPackage;
        } catch {
          return null;
        }
      }));
      const holderPackages = holderResults.filter((item): item is KeyPackage => item !== null);
      if (holderPackages.length < 3) throw new Error(`Only ${holderPackages.length} of five share holders responded; three are required`);
      const selectedPackages = holderPackages.slice(0, 3);

      const questionById = new Map(manifest.questions.map((question) => [question.questionId, question]));
      const entriesByHolder = selectedPackages.map((pkg) => new Map(pkg.entries.map((entry) => [entry.questionId, entry])));
      if (entriesByHolder.some((entries) => entries.size !== 75)) throw new Error("A share package contains duplicate question IDs");
      const decrypted = new Map<number, DecryptedQuestion>();
      await Promise.all(manifest.questions.map(async (question) => {
        const blob = ciphertexts.get(question.questionId);
        if (!blob) throw new Error(`Missing ciphertext for question ${question.questionId}`);
        const shares = await Promise.all(selectedPackages.map(async (pkg, holderOffset) => {
          const entry = entriesByHolder[holderOffset]!.get(question.questionId);
          if (!entry) throw new Error(`Share holder ${pkg.shareIndex} omitted question ${question.questionId}`);
          const data = await unsealShare(base64ToBytes(entry.sealedShare), centerKey.publicKey, centerKey.privateKey);
          if (keccak256(data).toLowerCase() !== question.keyShareHashes[pkg.shareIndex - 1]?.toLowerCase()) {
            throw new Error(`Question ${question.questionId}: share ${pkg.shareIndex} hash mismatch`);
          }
          return { index: pkg.shareIndex, data };
        }));
        const questionKey = combineQuestionKeyShares(shares);
        const opened = await decryptQuestion(blob, questionKey, question.objectId);
        if (keccak256(opened.envelope) !== question.plaintextCommitment) {
          throw new Error(`Question ${question.questionId}: plaintext commitment mismatch`);
        }
        decrypted.set(question.questionId, { ...opened.payload, questionId: question.questionId });
      }));

      const shiftQuestions = await manager.getFunction("getShiftQuestions")(manifest.shiftId) as readonly (bigint | number)[];
      const seed: string = await manager.getFunction("seed")();
      const orderedIds = centerOrder(seed, account, shiftQuestions.map(Number));
      const orderedPaper = orderedIds.map((questionId) => {
        const question = decrypted.get(questionId);
        if (!question || !questionById.has(questionId)) throw new Error(`Generated paper references unknown question ${questionId}`);
        return question;
      });
      setPaper(orderedPaper);
      const paperJson = {
        chainId: manifest.chainId,
        contract: manifest.contract,
        center: account,
        shiftId: manifest.shiftId,
        questionOrder: orderedIds,
      };
      downloadFile(`eplps-shift-${manifest.shiftId}-paper.json`, "application/json", JSON.stringify(paperJson, null, 2));
      downloadFile(`eplps-shift-${manifest.shiftId}-paper.html`, "text/html", makePrintablePaper(account, manifest.shiftId, orderedPaper));
      setStatus("Paper verified and exported. The printable HTML excludes correct answers.");
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The operation failed");
    }
  }

  return <main>
    <header><p className="eyebrow">EPLPS · EXAM CENTER</p><h1>Prepare your exam paper</h1><p>Verify encrypted materials early, then request your shift keys during the release window.</p></header>
    <section className="card"><h2>Center key setup</h2><p>Generate an X25519 key pair on this device. Give the public key to the administrator for registration and keep the downloaded private key file secure.</p><button disabled={busy} onClick={() => void run(generateCenterKey)}>Generate center key file</button>{generatedKey && <p className="public-key"><strong>Public key for registration</strong><code>{generatedKey.publicKey}</code></p>}</section>
    {!account ? <section className="card"><h2>Connect registered center wallet</h2><p>Your center key stays in this browser session. The paper is available only during your assigned shift window.</p><button onClick={() => void run(connectWallet)}>Connect wallet</button></section> : <>
      <section className="card summary"><div><span>Center</span><strong>{account}</strong></div><div><span>Assigned shift</span><strong>{manifest?.shiftId}</strong></div><div><span>Ciphertexts verified</span><strong>{ciphertexts.size} / 75</strong></div><button disabled={busy} onClick={() => void run(switchWallet)}>Switch wallet</button><button disabled={busy} onClick={disconnectWallet}>Disconnect</button></section>
      <section className="card"><h2>Key-release window</h2>{releaseWindow && chainTimestamp !== null ? chainTimestamp < releaseWindow.opensAt
        ? <p>Keys available in <strong>{formatDuration(releaseWindow.opensAt - chainTimestamp)}</strong> (chain time).</p>
        : chainTimestamp > releaseWindow.closesAt
          ? <p>This shift’s key-release window closed {formatDuration(chainTimestamp - releaseWindow.closesAt)} ago (chain time).</p>
          : <p>Open now · closes in <strong>{formatDuration(releaseWindow.closesAt - chainTimestamp)}</strong> (chain time).</p>
        : <p>Reading this shift’s schedule from the chain…</p>}<small>The countdown follows the latest chain block. The local demo chain may need its time advanced manually.</small></section>
      <section className="card"><h2>1. Fetch encrypted paper</h2><p>Download and hash-check all ciphertexts. This step does not release question keys.</p><button disabled={busy} onClick={() => void run(fetchCiphertexts)}>{busy ? "Working…" : "Fetch and verify ciphertexts"}</button></section>
      <section className="card"><h2>2. Load center key</h2><p>Select the center’s key file. The private key is used locally and is not uploaded.</p><input type="file" accept="application/json,.json" onChange={(event) => void run(() => importCenterKey(event.target.files?.[0]))} />{centerKey && <p className="success">Matching center key loaded in this session.</p>}</section>
      <section className="card"><h2>3. Request shares and build paper</h2><p>Three of five question-key shares are released only inside this center’s shift window. The center reconstructs keys locally. The exported paper contains no answers.</p><button disabled={busy || !centerKey || ciphertexts.size !== 75} onClick={() => void run(requestAndBuildPaper)}>{busy ? "Working…" : "Request shares and export paper"}</button>{paper && <p className="success">Paper ready · {paper.length} questions.</p>}</section>
    </>}
    <p className="status" role="status">{status}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><CenterApp /></React.StrictMode>);
