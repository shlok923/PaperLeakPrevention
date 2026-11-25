# Software Requirements Specification

## Exam Paper Leak-Prevention System Prototype

**Version:** 1.0  
**Status:** Prototype requirements baseline  
**Date:** 16 November 2026

## 1. Purpose

This document describes what the EPLPS prototype is expected to do. It is based on the current project architecture and the agreed prototype workflow. It is intended to guide implementation and testing; it does not claim that every workflow has already passed an end-to-end test.

## 2. Scope

EPLPS collects questions from registered submitters, creates shuffled exam sets, and delays access to each question until an eligible center's release window. The prototype uses a self-hosted Cosmos EVM chain, an S3-compatible object store, and web portals for administrators, submitters, and exam centers.

The fixed prototype size is:

- 3 subjects and 3 entities per subject;
- 9 submitters, one for each subject/entity combination;
- 50 questions per submitter, for 450 questions total;
- 6 shifts, each with 75 questions;
- 5 committee members who also act as question-key share holders;
- a 3-of-5 Shamir threshold for every question key.

The system has no exam-wide master key. Every question uses a separate encryption key.

## 3. Users and roles

| Role | Main responsibilities |
|---|---|
| Administrator | Configure the exam, register users and centers, manage phases, shifts, and deadlines, and finalize the exam. |
| Submitter | Upload 50 questions for the registered subject/entity using a registered EVM wallet. |
| Committee member / key holder | Commit and reveal randomness; keep one X25519 private key and release that holder's question shares when authorized. |
| Entropy relayer | Submit the configured external entropy value after the reveal deadline. |
| Exam center | Download encrypted questions, request shares during its shift window, and prepare the printable paper. |
| Auditor | Verify the chain history, question artifacts, randomness, paper sets, and post-exam commitments. |

The current portals use a browser-injected EVM wallet, such as MetaMask or a compatible wallet. Username/password login and walletless submission are outside this prototype.

## 4. System overview

The application consists of:

- **Smart contract:** stores exam configuration, commitments, encrypted share events, paper question IDs, and key-request records.
- **Web portals:** provide the administrator, submitter, and center workflows.
- **Application API:** verifies signed uploads, stores and serves encrypted question files, and provides status and center manifests.
- **S3-compatible storage:** RustFS locally; another compatible service may be used in deployment. It stores encrypted question files only.
- **Five key-holder services:** one service per share index and committee member.
- **Command-line tools:** support key generation, randomness commit/reveal, entropy submission, and audit.

Each question is encrypted in the submitter's browser before upload. Five Shamir shares of its AES key are encrypted separately to the five holder public keys. The submitter uploads the ciphertext files to object storage, then commits the full 50-question batch in one on-chain transaction, including all five holder-encrypted shares per question. At the center, each holder re-encrypts its share to the center's public key for delivery.

## 5. Functional requirements

### 5.1 Exam setup and administration

- **FR-01:** The administrator shall connect using the wallet registered as the contract administrator.
- **FR-02:** The administrator shall register exactly 9 submitters, with one unique submitter for each subject/entity combination.
- **FR-03:** The administrator shall register 5 distinct committee wallets and 5 distinct X25519 public keys in the same order.
- **FR-04:** The administrator shall set the entropy relayer, configure all 6 shifts, register centers with a wallet, shift, and X25519 public key, and configure commit, reveal, and entropy deadlines.
- **FR-05:** The administrator shall open submissions only after required setup is complete.
- **FR-06:** The administrator shall close submissions only after all 9 submitters have submitted 50 questions each.
- **FR-07:** The administrator shall be able to revoke a center, reschedule an eligible shift before key release, and finalize the exam after the final shift ends.
- **FR-08:** The system shall expose the current phase and basic progress information to the administrator.

### 5.2 Question submission

- **FR-09:** A submitter shall connect with a registered wallet. The contract-assigned subject and entity shall determine the submitter's pool.
- **FR-10:** The portal shall accept one JSON array containing exactly 50 questions. Each question shall have version `1`, subject `P`, `C`, or `M`, text, exactly four options, and a correct-option index from 0 to 3. An optional image shall include its name, MIME type, and base64 data.
- **FR-11:** The portal shall reject questions whose subject does not match the submitter's registered subject, malformed payloads, or payloads above the configured size limit.
- **FR-12:** The portal shall encrypt each question independently with AES-256-GCM and a unique random key before upload.
- **FR-13:** The crypto package shall split each question key into 5 Shamir shares such that any 3 distinct shares reconstruct the key.
- **FR-14:** Each share shall be encrypted to its corresponding holder's registered X25519 public key. The plaintext share shall not be written to the blockchain or object store.
- **FR-15:** The API shall store encrypted question files in S3-compatible storage. The contract shall store each question's ciphertext hash, object ID, plaintext commitment, and five plaintext-share hashes, and emit the five holder-encrypted shares.
- **FR-16:** After staging all 50 encrypted artifacts, the portal shall submit the submitter's 50 question records and holder-encrypted shares in one wallet-confirmed batch transaction. The contract shall validate and record the batch atomically, enforcing the submitter's role, subject/entity assignment, unique object IDs, and remaining quota for every item.
- **FR-17:** The portal shall show batch upload and transaction progress and support resuming interrupted uploads or retrying a failed batch, without displaying question text in application status messages. A reverted batch shall not partially consume the submitter's on-chain quota.

### 5.3 Randomness and paper-set generation

- **FR-18:** Each of the 5 committee members shall be able to submit one randomness commitment before the commit deadline and reveal the matching secret during the reveal window.
- **FR-19:** At least 3 valid committee reveals shall be required to generate paper sets.
- **FR-20:** The relayer shall submit the entropy value after the reveal deadline and before the entropy deadline. If no value is submitted by that deadline, the contract shall use the documented zero-value fallback.
- **FR-21:** The contract shall derive a deterministic seed from the available entropy and valid committee reveals in committee order.
- **FR-22:** The contract shall independently shuffle each subject/entity pool and distribute all 450 questions across 6 shifts. Each shift shall contain exactly 75 questions, with the entity pools contributing the specified 8/9 pattern.
- **FR-23:** Centers and auditors shall be able to retrieve the generated shift question IDs from the contract.

### 5.4 Center access and paper creation

- **FR-24:** A registered, non-revoked center shall be able to download encrypted files for its assigned shift before key release and verify each file against its on-chain ciphertext hash.
- **FR-25:** The center shall be able to request keys only from 15 minutes before its shift starts through 30 minutes after the start. The request shall be recorded by the contract.
- **FR-26:** Each key-holder service shall serve only its configured share index. Before releasing shares, it shall verify the center's signed request, the request transaction and event, the request time, the center's registration and revocation status, and its share hashes.
- **FR-27:** Each holder response shall contain shares encrypted to the registered center public key and be signed by the holder's EVM wallet.
- **FR-28:** The center shall verify holder identities and signatures, accept any 3 valid holder packages, decrypt and combine shares locally, reconstruct each question key, decrypt the question, and verify its plaintext commitment and schema.
- **FR-29:** The center shall order questions deterministically for its center and shift and export a printable HTML paper plus `paper.json`.
- **FR-30:** The printable paper shall include questions and options but omit correct answers. The center must not be able to request another center's package through the portal.

### 5.5 Finalization and audit

- **FR-31:** After all shifts end, the administrator shall be able to finalize the exam.
- **FR-32:** After finalization, the auditor shall be able to request signed share packages from holders for audit.
- **FR-33:** The auditor shall verify question counts, uniqueness, commitments, ciphertext and share hashes, committee randomness, generated shift distribution, key requests, and plaintext commitments.
- **FR-34:** The auditor shall produce a machine-readable report and a human-readable summary.

## 6. Data requirements

Each question payload has the following shape:

```json
{
  "v": 1,
  "subject": "P",
  "text": "Question text",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct": 0
}
```

`subject` is `P` for Physics, `C` for Chemistry, or `M` for Maths. `correct` is a zero-based index. The answer is part of the encrypted payload so authorized centers can validate and use it; the printable paper must omit it.

The chain stores public metadata, hashes, scheduling, question IDs, and holder-encrypted share bytes. The object store holds `<objectId>.ct` encrypted question files. Each submitter's full batch is recorded in one transaction; no Merkle root substitutes for the individual on-chain records in this prototype. Holder and center private keys are held outside the chain and are not uploaded by the portals.

## 7. External interfaces

- **EVM wallet:** The browser must have an injected provider and an account on the configured chain to connect and sign transactions.
- **Cosmos EVM JSON-RPC:** The contract and clients use standard EVM JSON-RPC and Solidity events. Local development uses Hardhat.
- **Object storage:** The API uses the S3 API to create a bucket and upload or retrieve encrypted objects.
- **Key-holder service API:** Centers submit a signed key-request reference and receive signed, center-encrypted share packages.
- **Entropy provider:** The relayer uses its configured provider; local development may use mock entropy for demonstration only.

## 8. Security and quality requirements

- **NFR-01:** Plaintext questions shall be encrypted before they leave the submitter's browser.
- **NFR-02:** AES keys and raw Shamir shares shall not be stored in plaintext on-chain or in object storage.
- **NFR-03:** A single holder shall not be able to recover a question key. Any 3 of 5 valid shares shall be sufficient.
- **NFR-04:** Center decryption shall happen locally in the browser. The center's X25519 private key shall not be sent to the API or key holders.
- **NFR-05:** The application shall check stored ciphertext and delivered shares against their on-chain commitments before use.
- **NFR-06:** Role-changing actions shall be signed by wallets and checked against contract authorization.
- **NFR-07:** The prototype shall run with configurable chain, contract, API, and object-store endpoints; it shall not rely on Cosmos-specific RPC extensions.
- **NFR-08:** Services shall report errors without logging question plaintext, AES keys, raw shares, or private keys.

These controls reduce early access and make tampering detectable. They cannot prevent a center from disclosing a paper after release or 3 colluding holders from reconstructing a key.

## 9. Prototype assumptions and limits

- The 450-question, 6-shift counts and 3-of-5 share threshold are fixed for this prototype.
- Committee members also serve as key holders to avoid introducing another group of users.
- Local object storage uses RustFS, an S3-compatible service. The target deployment can use another S3-compatible service.
- The original SRS's ExamKeypair/threshold key-wrapping path is replaced with per-question AES keys split directly by Shamir and individually encrypted to holder public keys. This is an intentional prototype deviation.
- The current center export is printable HTML and `paper.json`; PDF generation is not required by this version.
- The current wallet flow requires MetaMask or another compatible injected wallet. Account/password authentication and mobile-wallet QR connection are not included.
- Local Hardhat state is temporary and is lost when its node process stops. A self-hosted Cosmos EVM deployment must be separately tested for persistence and compatibility.
- Typecheck and build pass, but the full 450-question workflow and target-chain deployment remain to be verified end to end.

## 10. Acceptance checklist

The prototype is ready for demonstration when all of the following pass on the target test setup:

1. The admin can configure the required roles, holder keys, relayer, centers, shifts, and deadlines, then open the exam.
2. All 9 submitters can submit exactly 50 valid questions each with one wallet-confirmed batch transaction per submitter; the portal rejects invalid or wrong-subject files, and the contract rejects reused object IDs and over-quota batches atomically.
3. Encrypted question files are stored in the S3-compatible store and match their on-chain hashes; the chain contains five encrypted shares and five share hashes per question.
4. The committee and relayer can complete randomness, and the contract creates 6 distinct 75-question sets using all 450 submissions.
5. A center can fetch encrypted files early, cannot decrypt before the key window, and can reconstruct questions inside its window using any 3 of 5 valid holders.
6. Invalid signatures, share hashes, wallet roles, revoked centers, and out-of-window requests are rejected.
7. The printable output excludes answers, and the auditor can verify the finalized run and produce a passing report.
