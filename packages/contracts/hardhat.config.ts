import path from "node:path";
import dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import type { HardhatUserConfig } from "hardhat/config";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const cosmosChainId = Number(process.env.COSMOS_CHAIN_ID ?? 262144);
const cosmosRpcUrl = process.env.COSMOS_RPC_URL ?? "http://127.0.0.1:8545";
const cosmosDeployerKey = process.env.COSMOS_DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    cosmosEvm: {
      url: cosmosRpcUrl,
      chainId: cosmosChainId,
      accounts: cosmosDeployerKey ? [cosmosDeployerKey] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
