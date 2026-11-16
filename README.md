# EPLPS prototype

Exam Paper Leak-Prevention System prototype for a self-hosted Cosmos EVM chain. The system uses standard EVM JSON-RPC and Solidity contracts; chain-specific settings are supplied by environment configuration.

For the requirements and acceptance criteria, see [`docs/SRS.md`](docs/SRS.md). For a short status and workflow summary, see [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md). The detailed architecture baseline is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Paper generation uses the specified commit/reveal seed, Fisher–Yates entity-pool shuffle, and exact shift slicing. Each question has its own AES key, split into five Shamir shares with a 3-of-5 reconstruction threshold. Each share is sealed to its holder's X25519 public key and published in an on-chain event. This prototype has no exam-wide master key and intentionally differs from the original SRS key-wrapping design.

## Prerequisites

- Node.js 20 or later
- npm 9 or later
- Docker Compose
- A Cosmos EVM RPC endpoint for target-chain integration (Hardhat is used locally)

## Local setup

```sh
npm install
cp .env.example .env
docker compose up -d
npm run dev:chain
```

In a second terminal, deploy the contract to the local Hardhat node:

```sh
npm run deploy:local
```

Copy the printed address into `CONTRACT_ADDRESS` in `.env`. Start the API with `npm run dev:api`; the admin portal is available with `npm run dev:admin`. Submitter and center portals run with `npm run dev:submitter` and `npm run dev:center`. Register five committee wallets, then have each member run `npm run keyholder:gen-key` and provide its public key to the admin. Register those five X25519 public keys in the same order as the committee. Start five key-holder processes on ports 3001–3005, setting `KEY_SHARE_INDEX=1` through `5`, the matching committee signer key, and the generated private-key file path.

The API creates the chain-and-contract-scoped bucket when it starts. Local development uses RustFS as the S3-compatible file store for encrypted question ciphertexts; it does not store the shares. Its S3 API is at `http://127.0.0.1:9000` and console at `http://127.0.0.1:9001`. The admin portal configures roles, shifts, centers, and randomness deadlines. A center generates a local X25519 key file; give its public half to the admin for registration and keep the private file at the center. Submitters upload an exactly-50-question JSON array; encrypted artifacts are staged in browser IndexedDB to support retries. The API accepts ciphertext uploads with a wallet signature and checks hashes and quota. The submitter puts five encrypted shares in the same on-chain transaction as each question commitment.

The center portal downloads ciphertexts before release and verifies their on-chain hashes. In its shift window, it contacts the five holders; each returns its own share encrypted to the center and signed by its committee wallet. The center accepts any three valid responses, reconstructs each question key locally, checks plaintext commitments, and exports printable HTML without answers plus `paper.json` with the center-specific order.

Committee operations use `npm run committee:commit` and `npm run committee:reveal`; the secret is saved under `.keys/` and is never printed. The entropy relayer waits for the on-chain reveal deadline before reading its provider. Use `npm run relayer:run -- --provider local` for development, which emits an `INSECURE_DEV` warning, or configure the ANU endpoint and API key. After the exam is finalized, `npm run audit` replays the chain, asks holders for audit shares, reconstructs question keys, and checks ciphertext hashes and plaintext commitments.

The target Cosmos EVM profile starts from `.env.cosmos.example`: copy it to `.env`, then set the chain RPC/WebSocket endpoints and funded `COSMOS_DEPLOYER_PRIVATE_KEY`. Deploy with `npm run deploy:cosmos`. The script records the address, chain ID, timestamp, and transaction hash in `packages/contracts/deployments/<chain-id>.json`. Set `CONTRACT_ADDRESS` to that address for the application services. Do not reuse development private keys outside a local environment.

## Workspace map

- `packages/contracts`: Solidity contract and EVM deployment configuration
- `packages/crypto`: shared encryption, commitments, and deterministic paper algorithms
- `packages/shared`: validated configuration and shared EVM/API types
- `apps/api`: web workflow API
- `apps/key-service`: isolated timed key-release service
- `apps/admin-web`, `apps/submitter-web`, `apps/center-web`: user-facing portals
- `apps/*-cli`: operational and audit command-line clients

Implementation decisions and target-chain deployment details belong in `docs/DECISIONS.md` and `docs/DEPLOYMENT.md`.
