# Paper Leak Prevention Project Overview

## What the project does

The Exam Paper Leak-Prevention System collects questions, creates exam papers from them, and delays access to the questions until the exam window. The prototype is designed to run on a self-hosted Cosmos EVM chain.

## Architecture

- **Cosmos EVM contract:** records roles, schedules, question commitments, encrypted key shares, paper sets, and key requests.
- **RustFS:** a local S3-compatible file store for the larger encrypted question files. It does not store the key shares. The API uses an S3-compatible interface to upload and retrieve those files.
- **Submitter portal:** lets registered submitters encrypt and submit a package of 50 questions.
- **Admin portal:** configures submitters, committee members, holder keys, centers, shifts, and exam timing.
- **Five key-holder services:** each holds one share index and releases its shares when an eligible center requests them during its release window.
- **Center portal:** downloads encrypted questions early, requests shares at the allowed time, and builds the paper in the browser.
- **Committee, relayer, and auditor tools:** support randomness commit/reveal, entropy submission, and post-exam verification.

```text
Submitter portal ── encrypted question files ──> RustFS
       │
       └── commitments + five encrypted shares ──> Cosmos EVM

Center portal ── ciphertext files ──> RustFS
       │
       └── timed share request ──> 3 of 5 key holders
                                      │
                                      └── shares encrypted to center ──> Center portal
```

## Main question and paper flow

1. Each question is encrypted with its own AES key. The key is split into five Shamir shares; any three shares can recover it.
2. Each share is encrypted to its holder's public key. The encrypted shares and their integrity hashes are recorded on-chain. Only the matching holder's private key can decrypt a share.
3. The encrypted question file is uploaded to RustFS. The chain stores its hash and reference.
4. Committee members commit and reveal randomness. The contract uses it to shuffle the question pools and create the shift question sets.
5. A center can download and verify its encrypted question files before the exam, but cannot read the questions yet.
6. During its allowed release window, the center requests shares from the five holders. Each holder checks the request and sends its share encrypted to the center. Any three valid shares are enough to decrypt each question locally.
7. The center portal checks the decrypted questions and creates a printable paper without answers.
8. After the exam is finalized, the auditor can request signed shares from holders and verify the submissions and question commitments.

The prototype uses the five randomness committee members as the five key holders. It does not use a shared exam master key. This is a deliberate simplification from the key-wrapping approach described in parts of the SRS.

## Work implemented so far

- Solidity contract workflows for setup, submissions, randomness, paper-set generation, center key requests, and exam finalization.
- Per-question AES encryption and 3-of-5 Shamir splitting and reconstruction.
- X25519 encryption for holder and center share delivery.
- Submitter, admin, and center web portals.
- API endpoints for encrypted question-file upload and center retrieval.
- Five-index key-holder service design, with each process serving one committee member's shares.
- Committee key generation and randomness CLI, entropy relayer, and auditor CLI.
- Local and Cosmos EVM deployment configuration examples.

## Current status

The workspace typecheck and production build pass. The Solidity contract compiles but the full end-to-end flow is not tested yet on the cosmos chain.

## Next steps

1. Start the local chain and RustFS, deploy the contract, and complete setup with development accounts.
2. Run a small end-to-end submission, randomness, center-release, and audit flow.
3. Fix any issues found in that run, then repeat with the full prototype counts.
4. Deploy to the self-hosted Cosmos EVM chain and verify the same flow there.
