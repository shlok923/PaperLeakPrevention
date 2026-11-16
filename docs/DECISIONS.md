# Implementation decisions

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D-001 | Use standard EVM JSON-RPC and ethers v6 against both local Hardhat and Cosmos EVM. | Keep contract and clients chain-portable; avoid reliance on Cosmos-specific extensions. | Accepted |
| D-002 | Web portals are first-class clients over a TypeScript API; role transactions remain wallet-signed and contract-enforced. | Supports submitter, admin, and center workflows without moving contract authority into the API. | Accepted |
| D-003 | Preserve the SRS's commit/reveal seed, Fisher–Yates shuffle, deterministic slicing, and per-center ordering. | These define paper composition and must match across Solidity and TypeScript. | Accepted |
| D-004 | Split every question's AES key directly into five Shamir shares; any three reconstruct it. Do not create an ExamKeypair master key. Reuse the five randomness committee members as the five key-share holders. | This matches the user's intended submit/share/release workflow and avoids threshold X25519 partial decryption. It intentionally replaces the sealed-box flow in SRS §4.3 and differs from the ExamKeypair 3-of-5 stretch goal in §10.1. | Accepted (prototype deviation) |
| D-005 | Use RustFS as the local S3-compatible object store because the MinIO Docker Hub image used initially is no longer available; target deployment may use any compatible service. | Keeps blobs off-chain and makes local runs self-contained. | Accepted |
| D-006 | Local development and demonstrations may use mock entropy; production-like runs use the configured entropy provider and preserve the missed-window fallback. | Makes demos repeatable while retaining the documented relayer contract. | Accepted |
| D-007 | Use npm workspaces with TypeScript strict mode. | Shares crypto and typed clients across services, CLIs, and browser applications, using the package manager available in the development environment. | Accepted |

Target-chain distribution/version, wallet custody, API authentication, center-key persistence, shift overlap, and historical revocation semantics remain to be decided before those features are implemented.
