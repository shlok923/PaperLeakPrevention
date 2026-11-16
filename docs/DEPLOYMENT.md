# Deployment notes

## Local development

Hardhat provides a fast local EVM for contract development. RustFS provides local S3-compatible storage. Runtime services and portals run as workspace packages during development; Compose initially manages object storage only.

## Cosmos EVM target

The sibling Cosmos EVM project in this workspace uses chain ID `262144` and local JSON-RPC at `http://127.0.0.1:8545`. This project provides that as the default `cosmosEvm` profile. Copy `.env.cosmos.example` to `.env`, then set the funded `COSMOS_DEPLOYER_PRIVATE_KEY` and replace the RPC/WebSocket endpoints if your node exposes different addresses. Keep `CHAIN_ID`, `CHAIN_RPC_URL`, and `CHAIN_WS_URL` aligned with the target node for the API, key service, committee CLI, relayer, and auditor.

From the project root, deploy with `npm run deploy:cosmos`. The script writes `packages/contracts/deployments/<chain-id>.json` with the deployed address, chain ID, timestamp, and transaction hash. Keep this record with the matching runtime configuration.

Before deploying, record and validate:

- Cosmos EVM distribution and version, EVM compatibility level, chain ID, RPC and WebSocket endpoints;
- block time and finality behavior, transaction confirmation threshold, and reorganization handling;
- native gas token denomination and funded account process;
- validator/RPC ownership, upgrades, backups, monitoring, and recovery;
- TLS and network boundaries between API, object storage, and key service.

The application uses standard EVM JSON-RPC. WebSocket subscriptions are an optimization; consumers must reconnect and replay from a persisted block cursor. Validate deployment, event decoding, signing, timestamps, and gas behavior on a staging instance before relying on the target chain.
