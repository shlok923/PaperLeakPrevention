# Exam Paper Leak-Prevention System

**B.Tech Project Report**  
**Student:** [Name and roll number] · **Guide:** [Name] · **Department:** [Department] · **Institution:** [Institution]

## 1. Introduction

The Exam Paper Leak-Prevention System (EPLPS) is a prototype for securely collecting examination questions, generating shuffled papers, and controlling when exam centers can read them. It uses a self-hosted Cosmos EVM blockchain for records and access rules, S3-compatible storage for encrypted question files, and web portals for administrators, submitters, and centers.

The prototype is configured for nine submitters to submit 50 questions each. It uses five committee members/key holders, six shifts, 75 questions per shift, and a three-of-five threshold to recover each question key.

## 2. Problem

Questions can be exposed if they are shared too early, altered after submission, or made available to the wrong center. The system needs to protect question contents before the exam, produce verifiable paper sets, and release the information needed to decrypt a set only to its assigned center during a defined time window.

## 3. Architecture

The smart contract records roles, schedules, question metadata and hashes, encrypted key shares, randomness actions, generated shift question IDs, and center key requests. The API coordinates uploads and provides center manifests. RustFS stores the encrypted question files locally; another S3-compatible service can be used for deployment. Five key-holder services each manage one share index.

For each question, the submitter’s browser creates a separate AES encryption key and encrypts the question. It splits that key into five Shamir shares, any three of which can reconstruct it. Each share is encrypted to its holder’s X25519 public key. The submitter signs one upload authorization, uploads the encrypted files, then commits all 50 question records and their encrypted shares in one blockchain transaction. The plaintext and raw key shares are not stored on chain.

After submissions close, committee members reveal secrets that match their earlier on-chain commitments. The relayer submits an entropy value, which the contract checks against its raw data. The contract combines the available inputs into a seed, shuffles each subject/entity question pool, and records six sets of 75 question IDs.

An assigned center can download and verify its encrypted files early. During its release window—15 minutes before its shift through 30 minutes after—it requests keys on chain. Holders verify the request and return shares encrypted to the center. The center combines any three shares, decrypts and verifies questions in its browser, then exports a printable paper without correct answers.

## 4. Flowcharts

### Exam setup, submission, and paper-set generation

> **[Insert Excalidraw flowchart here]**

### Center fetches and prepares its paper

> **[Insert Excalidraw flowchart here]**

## 5. Security

Per-question keys limit the impact of exposing a single key. No single holder can reconstruct a question key; three holders can. On-chain hashes let the application detect changed ciphertexts or shares, while encrypted files remain off chain. Contract checks enforce center assignment and release timing, and center decryption happens locally.

The prototype cannot prevent three holders from cooperating early or an authorized center from disclosing a paper after release. A hash does not guarantee that stored files remain available. The security and availability of a self-hosted chain also depend on its operators and infrastructure. Local Hardhat and RustFS are for development; the target Cosmos EVM deployment still needs validation.

## 6. Conclusion

EPLPS combines encrypted question storage, threshold key sharing, verifiable randomness, and timed center access in one prototype workflow. It aims to reduce early exposure and make changes detectable, while keeping question decryption with the authorized center. Further end-to-end testing and validation on the target Cosmos EVM chain are needed before deployment.
