# EPLPS prototype

Exam Paper Leak-Prevention System prototype for a self-hosted Cosmos EVM chain. The system uses standard EVM JSON-RPC and Solidity contracts; chain-specific settings are supplied by environment configuration.

For the requirements and acceptance criteria, see [`docs/SRS.md`](docs/SRS.md). The B.Tech project report draft is in [`docs/PROJECT-REPORT.md`](docs/PROJECT-REPORT.md). For a short status and workflow summary, see [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md). The detailed architecture baseline is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and the end-to-end diagrams are in [`docs/APP-FLOWCHARTS.md`](docs/APP-FLOWCHARTS.md). Paper generation uses the specified commit/reveal seed, Fisher–Yates entity-pool shuffle, and exact shift slicing. Each question has its own AES key, split into five Shamir shares with a 3-of-5 reconstruction threshold. Each share is sealed to its holder's X25519 public key and published on chain. Submitters authorize all ciphertext uploads with one wallet signature, upload blobs to S3, then commit all 50 questions and their sealed shares in one batch transaction. This prototype has no exam-wide master key, does not use a Merkle-root-only submission, and intentionally differs from the original SRS key-wrapping design.

## Prerequisites

- Node.js 20 or later
- npm 9 or later
- Docker Compose
- A Cosmos EVM RPC endpoint for target-chain integration (Hardhat is used locally)

## Local setup

For the quickest repeatable test, use the [one-command local demo](#one-command-local-demo). The manual setup is below if you want to start each service yourself.

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

### One-command local demo

To automate local deployment and most of the setup, stop any running app processes and run:

```sh
npm run demo:local
```

The script starts RustFS and a fresh local Hardhat chain, deploys the updated contract, reads the development accounts from `docs/benchmarks.txt`, registers roles and centers, creates missing holder keys, and starts the API, five key-holder services, and all three portals. It submits demo batches for eight submitters and leaves the Physics/entity 1 wallet unsubmitted so you can test the submitter portal itself. Connect that wallet at `http://127.0.0.1:5174` and submit `examples/questions-physics-entity-1.json`. Expect one wallet signature for the upload authorization and one batch transaction. Once it confirms, the script closes submissions, completes randomness on the local chain, and generates the shift sets. If your Docker setup requires elevated permissions, start RustFS first with `sudo docker compose up -d`, then run the demo script.

The script prints the center wallet and its private-key file path. Use those in `http://127.0.0.1:5175` to test ciphertext fetching and timed paper generation. The first shift's key window is open for the demo. Press Ctrl+C in the script terminal to stop the chain and app services. This is local-only: the script advances the Hardhat clock to complete the randomness schedule and updates `.env` with the fresh contract address. It does not use or print the private-key values from `docs/benchmarks.txt`.

The API creates the chain-and-contract-scoped bucket when it starts. Local development uses RustFS as the S3-compatible file store for encrypted question ciphertexts; it does not store the shares. Its S3 API is at `http://127.0.0.1:9000` and console at `http://127.0.0.1:9001`. The admin portal configures roles, shifts, centers, and randomness deadlines. A center generates a local X25519 key file; give its public half to the admin for registration and keep the private file at the center. Submitters upload an exactly-50-question JSON array; encrypted artifacts are staged in browser IndexedDB to support retries. The submitter signs one authorization for the ordered upload manifest, uploads its ciphertexts, then submits all five encrypted shares per question on chain in one batch transaction.

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
