import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserProvider,
  Contract,
  getAddress,
  keccak256,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import {
  canonicalJson,
  encryptQuestion,
  sealShare,
  validatePayload,
  type EncryptedQuestion,
  type QuestionPayload,
} from "@eplps/crypto";
import { createExamManager } from "@eplps/shared";
import "./style.css";

type NetworkInfo = { chainId: number; contract: string };
type StoredArtifact = EncryptedQuestion & { fingerprint: string; encryptedShares: Uint8Array[] };
type SubmissionEvent = { ciphertextHash: string };
type InjectedWallet = ConstructorParameters<typeof BrowserProvider>[0] & {
  on?: (event: "accountsChanged", listener: (accounts: string[]) => void) => void;
  removeListener?: (event: "accountsChanged", listener: (accounts: string[]) => void) => void;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

let artifactDbPromise: Promise<IDBDatabase> | undefined;
let artifactDbConnection: IDBDatabase | undefined;

function getArtifactDb(): Promise<IDBDatabase> {
  if (artifactDbPromise) return artifactDbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("eplps-submitter-artifacts-v2", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("artifacts")) db.createObjectStore("artifacts", { keyPath: "fingerprint" });
    };
    request.onsuccess = () => {
      const db = request.result;
      artifactDbConnection = db;
      const forgetConnection = () => {
        if (artifactDbConnection === db) {
          artifactDbConnection = undefined;
          artifactDbPromise = undefined;
        }
      };
      db.onversionchange = () => {
        db.close();
        forgetConnection();
      };
      db.onclose = forgetConnection;
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open local encrypted-artifact storage"));
  });
  artifactDbPromise = opening;
  void opening.catch(() => {
    if (artifactDbPromise === opening) artifactDbPromise = undefined;
  });
  return opening;
}

async function dbRequest<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const db = await getArtifactDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("artifacts", mode);
        const request = action(transaction.objectStore("artifacts"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Local artifact storage failed"));
      });
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === "InvalidStateError") {
        try { db.close(); } catch { /* The database may already be closed. */ }
        if (artifactDbConnection === db) {
          artifactDbConnection = undefined;
          artifactDbPromise = undefined;
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to access local encrypted-artifact storage");
}

function saveArtifact(artifact: StoredArtifact): Promise<IDBValidKey> {
  return dbRequest("readwrite", (store) => store.put(artifact));
}

function findArtifact(fingerprint: string): Promise<StoredArtifact | undefined> {
  return dbRequest("readonly", (store) => store.get(fingerprint));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function statusFromApi(): Promise<NetworkInfo> {
  const response = await fetch(`${API_BASE}/v1/status`);
  if (!response.ok) throw new Error("Could not read network configuration from the API");
  return response.json() as Promise<NetworkInfo>;
}

function SubmitterApp() {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [contract, setContract] = useState<Contract | null>(null);
  const [account, setAccount] = useState("");
  const [subject, setSubject] = useState<number | null>(null);
  const [entity, setEntity] = useState<number | null>(null);
  const [quotaUsed, setQuotaUsed] = useState(0);
  const [payloads, setPayloads] = useState<QuestionPayload[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Connect your registered submitter wallet to begin.");

  useEffect(() => {
    const ethereum = (window as Window & { ethereum?: InjectedWallet }).ethereum;
    if (!ethereum?.on) return;
    const handleAccountsChanged = (accounts: string[]) => {
      setProvider(null);
      setContract(null);
      setAccount("");
      setSubject(null);
      setEntity(null);
      setQuotaUsed(0);
      setPayloads([]);
      setFileName("");
      setStatus(accounts.length
        ? "Wallet account changed. Connect the selected registered submitter wallet."
        : "Wallet disconnected. Connect a registered submitter wallet to continue.");
    };
    ethereum.on("accountsChanged", handleAccountsChanged);
    return () => ethereum.removeListener?.("accountsChanged", handleAccountsChanged);
  }, []);

  function disconnectWallet(): void {
    setProvider(null);
    setContract(null);
    setAccount("");
    setSubject(null);
    setEntity(null);
    setQuotaUsed(0);
    setPayloads([]);
    setFileName("");
    setStatus("Disconnected from this submitter session. Select another wallet in MetaMask, then connect again.");
  }

  async function switchWallet(): Promise<void> {
    const ethereum = (window as Window & { ethereum?: InjectedWallet }).ethereum;
    if (!ethereum) throw new Error("No EVM wallet was found in this browser");
    const browserProvider = new BrowserProvider(ethereum);
    try {
      await browserProvider.send("wallet_revokePermissions", [{ eth_accounts: {} }]);
    } catch {
      // Some injected wallets do not implement permission revocation; request account selection directly.
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
    const signer = await browserProvider.getSigner();
    const address = getAddress(await signer.getAddress());
    const chain = await browserProvider.getNetwork();
    const network = await statusFromApi();
    if (Number(chain.chainId) !== network.chainId) throw new Error(`Wallet is on chain ${chain.chainId}; expected ${network.chainId}`);
    const readContract = createExamManager(network.contract, browserProvider) as Contract;
    if (!await readContract.getFunction("isSubmitter")(address)) throw new Error("This wallet is not a registered submitter");
    const registeredSubject = Number(await readContract.getFunction("submitterSubject")(address));
    const registeredEntity = Number(await readContract.getFunction("submitterEntity")(address));
    const currentCount = Number(await readContract.getFunction("submitterQuestionCount")(address));
    setProvider(browserProvider);
    setContract(createExamManager(network.contract, signer) as Contract);
    setAccount(address);
    setSubject(registeredSubject);
    setEntity(registeredEntity);
    setQuotaUsed(currentCount);
    setStatus(`Connected as subject ${registeredSubject} · entity ${registeredEntity}.`);
  }

  async function loadQuestions(file?: File): Promise<void> {
    if (!file) return;
    const parsed: unknown = JSON.parse(await file.text());
    if (!Array.isArray(parsed) || parsed.length !== 50) throw new Error("Select a JSON array containing exactly 50 questions");
    const validated = parsed.map((payload) => validatePayload(payload));
    setPayloads(validated);
    setFileName(file.name);
    setStatus("50 questions passed schema validation. Question text remains in this browser until submitted.");
  }

  async function uploadArtifact(artifact: StoredArtifact, signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const uploadMessage = `EPLPS-UPLOAD:${Number((await provider!.getNetwork()).chainId)}:${await contract!.getAddress()}:${account}:${artifact.objectId}:${artifact.ciphertextHash}:${timestamp}`;
    const signature = await signer.signMessage(uploadMessage);
    const response = await fetch(`${API_BASE}/v1/submitters/${account}/objects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: artifact.objectId,
        ciphertextHash: artifact.ciphertextHash,
        timestamp,
        signature,
        dataBase64: bytesToBase64(artifact.blob),
      }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error ?? `Ciphertext upload failed (${response.status})`);
    }
  }

  async function submitBatch(): Promise<void> {
    if (!provider || !contract || subject === null || entity === null) throw new Error("Connect a registered submitter wallet first");
    if (payloads.length !== 50) throw new Error("Load and validate exactly 50 questions first");
    setBusy(true);
    try {
      const phase = Number(await contract.getFunction("phase")());
      if (phase !== 1) throw new Error("The exam is not currently accepting submissions");
      const expectedSubject = ["P", "C", "M"][subject];
      if (payloads.some((payload) => payload.subject !== expectedSubject)) {
        throw new Error(`Every question in this file must be for your registered subject (${expectedSubject})`);
      }
      const keyCount = Number(await contract.getFunction("submitterQuestionCount")(account));
      if (keyCount > 50) throw new Error("On-chain question quota is invalid");
      setQuotaUsed(keyCount);
      const holderPublicKeys = await Promise.all(Array.from({ length: 5 }, async (_, index) =>
        String(await contract.getFunction("keyHolderPublicKeys")(index))));
      const event = contract.interface.getEvent("QuestionSubmitted");
      if (!event) throw new Error("QuestionSubmitted event is missing from the shared contract ABI");
      const logs = await provider.getLogs({
        address: await contract.getAddress(),
        fromBlock: 0,
        topics: [event.topicHash, null, zeroPadValue(account, 32)],
      });
      const committedHashes = new Set<string>();
      for (const log of logs) {
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "QuestionSubmitted") committedHashes.add(String(parsed.args.ciphertextHash).toLowerCase());
      }
      const signer = await provider.getSigner(account);
      let completed = keyCount;

      for (let index = 0; index < payloads.length; index += 1) {
        const payload = payloads[index]!;
        const fingerprint = keccak256(toUtf8Bytes(canonicalJson(payload)));
        let artifact = await findArtifact(fingerprint);
        if (!artifact) {
          const encrypted = await encryptQuestion(payload);
          const encryptedShares = await Promise.all(encrypted.keyShares.map((share, shareIndex) =>
            sealShare(holderPublicKeys[shareIndex]!, share.data)));
          artifact = { fingerprint, ...encrypted, encryptedShares };
          await saveArtifact(artifact);
        } else if (!artifact.encryptedShares || artifact.encryptedShares.length !== 5) {
          artifact.encryptedShares = await Promise.all(artifact.keyShares.map((share, shareIndex) =>
            sealShare(holderPublicKeys[shareIndex]!, share.data)));
          await saveArtifact(artifact);
        }
        if (committedHashes.has(artifact.ciphertextHash.toLowerCase())) {
          setStatus(`Resumed batch · ${Math.min(index + 1, 50)} of 50 checked · ${completed} questions already committed.`);
          continue;
        }
        if (completed >= 50) throw new Error("This submitter has reached the 50-question quota");

        setStatus(`Encrypting and uploading question ${index + 1} of 50…`);
        await uploadArtifact(artifact, signer);
        setStatus(`Encrypted artifacts uploaded · submitting commitment ${index + 1} of 50…`);
        const tx = await contract.getFunction("submitQuestion")(
          artifact.ciphertextHash,
          artifact.keyShareHashes,
          artifact.plaintextCommitment,
          artifact.objectId,
          artifact.encryptedShares,
        );
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error(`Question ${index + 1} commitment failed`);
        committedHashes.add(artifact.ciphertextHash.toLowerCase());
        completed += 1;
        setQuotaUsed(completed);
        setStatus(`Committed ${completed} of 50 questions · transaction ${receipt.hash}`);
      }
      setStatus(`Submission complete or resumed. On-chain quota: ${completed} of 50.`);
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
    <header><p className="eyebrow">EPLPS · QUESTION SUBMISSION</p><h1>Submit questions securely</h1><p>Each question is encrypted in this browser before its artifacts are uploaded or committed on-chain.</p></header>
    {!account ? <section className="card"><h2>Connect submitter wallet</h2><p>Your registered wallet determines your subject and entity. The contract enforces a maximum of 50 questions.</p><button onClick={() => void run(connectWallet)}>Connect wallet</button></section> : <>
      <section className="card summary"><div><span>Submitter wallet</span><strong>{account}</strong></div><div><span>Subject</span><strong>{["Physics", "Chemistry", "Maths"][subject!]}</strong></div><div><span>Entity</span><strong>{entity! + 1}</strong></div><div><span>On-chain quota</span><strong>{quotaUsed} / 50</strong></div><button disabled={busy} onClick={() => void run(switchWallet)}>Switch wallet</button><button disabled={busy} onClick={disconnectWallet}>Disconnect</button></section>
      <section className="card"><h2>Question package</h2><p>Choose a JSON array of exactly 50 single-correct MCQs. The interface never displays question content.</p><input type="file" accept="application/json,.json" onChange={(event) => void run(() => loadQuestions(event.target.files?.[0]))} />{payloads.length > 0 && <p className="success">{fileName} · {payloads.length} questions validated.</p>}</section>
      <section className="card"><h2>Encrypt and submit</h2><p>Question ciphertext is uploaded to object storage. Five Shamir shares are encrypted to their holders and submitted with the on-chain commitment.</p><button disabled={busy || payloads.length !== 50 || quotaUsed === 50} onClick={() => void run(submitBatch)}>{busy ? "Submitting…" : "Submit or resume 50 questions"}</button></section>
    </>}
    <p className="status" role="status">{status}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><SubmitterApp /></React.StrictMode>);
