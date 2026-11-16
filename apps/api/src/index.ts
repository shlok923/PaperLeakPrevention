import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import Fastify from "fastify";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { JsonRpcProvider, getAddress, keccak256, verifyMessage } from "ethers";
import { createExamManager, loadRuntimeConfig } from "@eplps/shared";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const runtime = loadRuntimeConfig(process.env);
if (!runtime.contractAddress) throw new Error("CONTRACT_ADDRESS is required by the API service");

const provider = new JsonRpcProvider(runtime.chainRpcUrl, runtime.chainId);
const contract = createExamManager(runtime.contractAddress, provider);
const storageConfig = {
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET || `eplps-${runtime.chainId}-${runtime.contractAddress.toLowerCase()}`,
  accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
};
const s3 = new S3Client({
  endpoint: storageConfig.endpoint,
  region: storageConfig.region,
  forcePathStyle: storageConfig.forcePathStyle,
  credentials: { accessKeyId: storageConfig.accessKeyId, secretAccessKey: storageConfig.secretAccessKey },
});
const app = Fastify({ logger: true, bodyLimit: 2_200_000 });

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: storageConfig.bucket }));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (!/NotFound|NoSuchBucket|NotFound|404/i.test(name)) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: storageConfig.bucket }));
  }
}

const uploadSchema = z.object({
  objectId: z.string().regex(/^0x[0-9a-fA-F]{32}$/),
  ciphertextHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  dataBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

const phaseNames = ["Setup", "Submission", "Randomness", "Generated", "Closed"] as const;

app.get("/health", async () => ({ service: "eplps-api", status: "ok" }));

app.get("/v1/status", async () => {
  const [network, phase, totalSubmissions, submitterCount, revealCount, anuSubmitted, commitDeadline, revealDeadline, anuDeadline] = await Promise.all([
    provider.getNetwork(),
    contract.getFunction("phase")(),
    contract.getFunction("totalSubmissions")(),
    contract.getFunction("submitterCount")(),
    contract.getFunction("revealCount")(),
    contract.getFunction("anuSubmitted")(),
    contract.getFunction("commitDeadline")(),
    contract.getFunction("revealDeadline")(),
    contract.getFunction("anuDeadline")(),
  ]);
  const phaseId = Number(phase);
  return {
    chainId: Number(network.chainId),
    contract: runtime.contractAddress,
    phase: phaseNames[phaseId] ?? "Unknown",
    totalSubmissions: Number(totalSubmissions),
    registeredSubmitters: Number(submitterCount),
    committeeReveals: Number(revealCount),
    anuSubmitted,
    deadlines: {
      commit: Number(commitDeadline),
      reveal: Number(revealDeadline),
      anu: Number(anuDeadline),
    },
  };
});

app.get("/v1/shifts", async () => {
  const shifts = await Promise.all(Array.from({ length: 6 }, async (_, shiftId) => {
    const shift = await contract.getFunction("shifts")(shiftId);
    return {
      shiftId,
      startTime: Number(shift.startTime),
      endTime: Number(shift.endTime),
      keysReleased: shift.keysReleased as boolean,
    };
  }));
  return { shifts };
});

app.post<{ Params: { address: string } }>("/v1/submitters/:address/objects", async (request, reply) => {
  let submitter: string;
  try {
    submitter = getAddress(request.params.address);
  } catch {
    return reply.code(400).send({ error: "invalid_submitter_address" });
  }
  const parsed = uploadSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_upload_request" });
  const body = parsed.data;
  if (Math.abs(Math.floor(Date.now() / 1000) - body.timestamp) > 120) {
    return reply.code(400).send({ error: "stale_upload_signature" });
  }
  const uploadMessage = `EPLPS-UPLOAD:${runtime.chainId}:${runtime.contractAddress}:${submitter}:${body.objectId}:${body.ciphertextHash}:${body.timestamp}`;
  if (getAddress(verifyMessage(uploadMessage, body.signature)) !== submitter) {
    return reply.code(403).send({ error: "invalid_submitter_signature" });
  }
  const [phase, registered, questionCount] = await Promise.all([
    contract.getFunction("phase")(),
    contract.getFunction("isSubmitter")(submitter),
    contract.getFunction("submitterQuestionCount")(submitter),
  ]);
  if (Number(phase) !== 1 || !registered || Number(questionCount) >= 50) {
    return reply.code(403).send({ error: "submitter_not_eligible" });
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (bytes.length === 0 || keccak256(bytes) !== body.ciphertextHash) {
    return reply.code(400).send({ error: "upload_hash_mismatch" });
  }
  const objectKey = `${body.objectId.slice(2).toLowerCase()}.ct`;
  await s3.send(new PutObjectCommand({
    Bucket: storageConfig.bucket,
    Key: objectKey,
    Body: bytes,
    ContentType: "application/octet-stream",
  }));
  return reply.send({ stored: true, objectId: body.objectId, kind: "ct", ciphertextHash: body.ciphertextHash });
});

app.get<{ Params: { center: string } }>("/v1/centers/:center/manifest", async (request, reply) => {
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  if (!addressPattern.test(request.params.center)) return reply.code(400).send({ error: "invalid_center_address" });
  const center = request.params.center;
  const centerState = await contract.getFunction("centers")(center);
  if (!centerState.registered || centerState.revoked) return reply.code(403).send({ error: "center_not_eligible" });
  const phase = Number(await contract.getFunction("phase")());
  if (phase < 3) return reply.code(409).send({ error: "shift_paper_not_generated" });
  const shiftId = Number(centerState.shiftId);
  const ids = await contract.getFunction("getShiftQuestions")(shiftId) as readonly (bigint | number)[];
  if (ids.length !== 75) return reply.code(409).send({ error: "shift_paper_not_generated" });

  const questions = await Promise.all(ids.map(async (rawId) => {
    const questionId = Number(rawId);
    const submission = await contract.getFunction("getSubmission")(questionId);
    return {
      questionId,
      objectId: submission.objectId as string,
      ciphertextHash: submission.ciphertextHash as string,
      keyShareHashes: [...submission.keyShareHashes as readonly string[]],
      plaintextCommitment: submission.plaintextCommitment as string,
      ciphertextUrl: `/v1/questions/${questionId}/ciphertext`,
    };
  }));
  return reply.send({
    chainId: runtime.chainId,
    contract: runtime.contractAddress,
    center,
    shiftId,
    centerPublicKey: centerState.x25519PubKey as string,
    questions,
  });
});

app.get<{ Params: { questionId: string } }>("/v1/questions/:questionId/ciphertext", async (request, reply) => {
  if (!/^\d{1,3}$/.test(request.params.questionId)) return reply.code(400).send({ error: "invalid_question_id" });
  const questionId = Number(request.params.questionId);
  if (questionId >= 450) return reply.code(400).send({ error: "invalid_question_id" });
  const submission = await contract.getFunction("getSubmission")(questionId);
  const objectId = (submission.objectId as string).toLowerCase().replace(/^0x/, "");
  const object = await s3.send(new GetObjectCommand({
    Bucket: storageConfig.bucket,
    Key: `${objectId}.ct`,
  }));
  if (!object.Body) return reply.code(502).send({ error: "ciphertext_unavailable" });
  const blob = new Uint8Array(await object.Body.transformToByteArray());
  if (keccak256(blob) !== submission.ciphertextHash) {
    request.log.error({ questionId }, "stored ciphertext failed on-chain hash check");
    return reply.code(502).send({ error: "ciphertext_integrity_failure" });
  }
  return reply.type("application/octet-stream").header("cache-control", "private, max-age=300").send(Buffer.from(blob));
});

const port = Number(process.env.API_PORT ?? 3000);
await ensureBucket();
await app.listen({ host: "0.0.0.0", port });
