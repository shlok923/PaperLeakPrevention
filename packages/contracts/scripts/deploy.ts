import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ethers } from "hardhat";

async function main(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  const manager = await ethers.deployContract("ExamManager", [900, 1800]);
  await manager.waitForDeployment();

  const address = await manager.getAddress();
  const transactionHash = manager.deploymentTransaction()?.hash;
  const deployment = {
    contract: "ExamManager",
    address,
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    transactionHash: transactionHash ?? null,
  };
  const outputDir = path.resolve(__dirname, "../deployments");
  await mkdir(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `${deployment.chainId}.json`);
  await writeFile(outputFile, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

  console.log(`ExamManager deployed at ${address}`);
  console.log(`Deployment details written to ${outputFile}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
