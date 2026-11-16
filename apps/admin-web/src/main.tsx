import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserProvider, Contract, getAddress } from "ethers";
import { createExamManager } from "@eplps/shared";
import "./style.css";

type NetworkStatus = {
  chainId: number;
  contract: string;
  phase: string;
  totalSubmissions: number;
  registeredSubmitters: number;
  committeeReveals: number;
  anuSubmitted: boolean;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function getStatus(): Promise<NetworkStatus> {
  const response = await fetch(`${API_BASE}/v1/status`);
  if (!response.ok) throw new Error("Unable to read contract status from the API");
  return response.json() as Promise<NetworkStatus>;
}

function readForm(event: React.FormEvent<HTMLFormElement>): Record<string, string> {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
}

function requiredField(data: Record<string, string>, name: string): string {
  const value = data[name];
  if (!value) throw new Error(`Missing form field: ${name}`);
  return value;
}

function timestamp(value: string): bigint {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Enter a valid date and time");
  return BigInt(Math.floor(parsed / 1000));
}

function AdminApp() {
  const [contract, setContract] = useState<Contract | null>(null);
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Connect the contract administrator wallet to manage the exam lifecycle.");

  async function connect(): Promise<void> {
    const ethereum = (window as Window & { ethereum?: ConstructorParameters<typeof BrowserProvider>[0] }).ethereum;
    if (!ethereum) throw new Error("No EVM wallet was found in this browser");
    const provider = new BrowserProvider(ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const address = getAddress(await signer.getAddress());
    const live = await getStatus();
    const chain = await provider.getNetwork();
    if (Number(chain.chainId) !== live.chainId) throw new Error(`Wallet is on chain ${chain.chainId}; expected ${live.chainId}`);
    const instance = createExamManager(live.contract, signer) as Contract;
    const admin: string = await instance.getFunction("admin")();
    if (getAddress(admin) !== address) throw new Error("Connected wallet is not the on-chain administrator");
    setContract(instance);
    setAccount(address);
    setNetwork(live);
    setStatus(`Connected as administrator on chain ${live.chainId}.`);
  }

  async function transact(method: string, args: readonly unknown[] = []): Promise<void> {
    if (!contract) throw new Error("Connect the admin wallet first");
    setBusy(true);
    try {
      const tx = await contract.getFunction(method)(...args);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(`${method} transaction failed`);
      setNetwork(await getStatus());
      setStatus(`${method} confirmed in ${receipt.hash}.`);
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

  const submitterForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    return run(() => transact("registerSubmitter", [requiredField(data, "address"), Number(requiredField(data, "subject")), Number(requiredField(data, "entity"))]));
  };
  const committeeForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    const members = requiredField(data, "members").split(/[\n,\s]+/).filter(Boolean);
    if (members.length !== 5) return run(async () => { throw new Error("Enter exactly five committee addresses"); });
    return run(() => transact("registerCommittee", [members]));
  };
  const keyHolderKeysForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    const keys = requiredField(data, "publicKeys").split(/[\n,\s]+/).filter(Boolean);
    if (keys.length !== 5 || keys.some((key) => !/^0x[0-9a-fA-F]{64}$/.test(key))) {
      return run(async () => { throw new Error("Enter five 32-byte X25519 public keys from the key holders"); });
    }
    return run(() => transact("setKeyHolderPublicKeys", [keys]));
  };
  const shiftForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    return run(() => transact("setShift", [Number(requiredField(data, "shiftId")), timestamp(requiredField(data, "start")), timestamp(requiredField(data, "end"))]));
  };
  const centerForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    return run(() => transact("registerCenter", [requiredField(data, "address"), Number(requiredField(data, "shiftId")), requiredField(data, "publicKey")]));
  };
  const randomnessForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    return run(() => transact("configureRandomness", [timestamp(requiredField(data, "commit")), timestamp(requiredField(data, "reveal")), timestamp(requiredField(data, "anu"))]));
  };
  const rescheduleForm = (event: React.FormEvent<HTMLFormElement>) => {
    const data = readForm(event);
    return run(() => transact("rescheduleShift", [Number(requiredField(data, "shiftId")), timestamp(requiredField(data, "start")), timestamp(requiredField(data, "end"))]));
  };

  return <main>
    <header><p className="eyebrow">EPLPS · OPERATIONS</p><h1>Exam administration</h1><p>Configure actors and schedule, then advance the on-chain exam lifecycle.</p></header>
    {!contract ? <section className="card"><h2>Administrator wallet</h2><p>All state changes are signed by the wallet registered as the contract admin.</p><button disabled={busy} onClick={() => void run(connect)}>Connect admin wallet</button></section> : <>
      {network && <section className="card metrics"><div><span>Phase</span><strong>{network.phase}</strong></div><div><span>Questions committed</span><strong>{network.totalSubmissions} / 450</strong></div><div><span>Committee reveals</span><strong>{network.committeeReveals} / 5</strong></div><div><span>ANU entropy</span><strong>{network.anuSubmitted ? "Submitted" : "Pending"}</strong></div></section>}
      <p className="wallet">Admin wallet: <strong>{account}</strong></p>
      <section className="card"><h2>Register submitter</h2><form onSubmit={submitterForm}><label>Wallet address<input name="address" required placeholder="0x…" /></label><label>Subject<select name="subject"><option value="0">Physics</option><option value="1">Chemistry</option><option value="2">Maths</option></select></label><label>Entity<select name="entity"><option value="0">Entity 1</option><option value="1">Entity 2</option><option value="2">Entity 3</option></select></label><button disabled={busy}>Register submitter</button></form></section>
      <section className="card"><h2>Register committee and key-share holders</h2><p>Each of these five members contributes randomness and holds one index of every question’s Shamir shares.</p><form onSubmit={committeeForm}><label>Five wallet addresses, one per line<textarea name="members" required rows={5} placeholder="0x…" /></label><button disabled={busy}>Register committee and holders</button></form></section>
      <section className="card"><h2>Register holder encryption keys</h2><p>Collect one X25519 public key from each committee member, in the same order as their wallet addresses. Shares are sealed to these keys before being written on-chain.</p><form onSubmit={keyHolderKeysForm}><label>Five X25519 public keys, one per line<textarea name="publicKeys" required rows={5} placeholder="0x…" /></label><button disabled={busy}>Register holder public keys</button></form></section>
      <section className="card"><h2>Register entropy relayer</h2><form onSubmit={(event) => { const d = readForm(event); return run(() => transact("setRelayer", [requiredField(d, "address")])); }}><label>Entropy relayer wallet<input name="address" required placeholder="0x…" /></label><button disabled={busy}>Set relayer</button></form></section>
      <section className="card"><h2>Configure shifts</h2><form onSubmit={shiftForm}><label>Shift ID<select name="shiftId">{Array.from({ length: 6 }, (_, id) => <option value={id} key={id}>{id}</option>)}</select></label><label>Start time<input name="start" type="datetime-local" required /></label><label>End time<input name="end" type="datetime-local" required /></label><button disabled={busy}>Register shift</button></form></section>
      <section className="card"><h2>Register center</h2><form onSubmit={centerForm}><label>Center wallet<input name="address" required placeholder="0x…" /></label><label>Shift ID<select name="shiftId">{Array.from({ length: 6 }, (_, id) => <option value={id} key={id}>{id}</option>)}</select></label><label>Center X25519 public key<input name="publicKey" required placeholder="0x… 32-byte key" /></label><button disabled={busy}>Register center</button></form></section>
      <section className="card"><h2>Randomness schedule</h2><form onSubmit={randomnessForm}><label>Commit deadline<input name="commit" type="datetime-local" required /></label><label>Reveal deadline<input name="reveal" type="datetime-local" required /></label><label>ANU deadline<input name="anu" type="datetime-local" required /></label><button disabled={busy}>Configure deadlines</button></form></section>
      <section className="card"><h2>Lifecycle</h2><div className="button-row"><button disabled={busy} onClick={() => void run(() => transact("openSubmissions"))}>Open submissions</button><button disabled={busy} onClick={() => void run(() => transact("closeSubmissions"))}>Close submissions</button><button disabled={busy} onClick={() => void run(() => transact("generateSets"))}>Generate shift papers</button></div></section>
      <section className="card"><h2>Center and schedule changes</h2><form onSubmit={(event) => { const d = readForm(event); return run(() => transact("revokeCenter", [requiredField(d, "address")])); }}><label>Revoke center wallet<input name="address" required placeholder="0x…" /></label><button disabled={busy}>Revoke center</button></form><form onSubmit={rescheduleForm}><label>Shift ID<select name="shiftId">{Array.from({ length: 6 }, (_, id) => <option value={id} key={id}>{id}</option>)}</select></label><label>New start<input name="start" type="datetime-local" required /></label><label>New end<input name="end" type="datetime-local" required /></label><button disabled={busy}>Reschedule shift</button></form></section>
      <section className="card"><h2>Close exam for audit</h2><p>After the last shift ends, close the exam. The auditor then reconstructs question keys from threshold shares.</p><button disabled={busy} onClick={() => void run(() => transact("finalizeExam"))}>Finalize exam</button></section>
    </>}
    <p className="status" role="status">{status}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><AdminApp /></React.StrictMode>);
