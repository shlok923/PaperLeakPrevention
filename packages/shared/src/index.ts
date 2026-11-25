import { z } from "zod";
import { Contract, Provider, Signer, getAddress } from "ethers";

export const runtimeConfigSchema = z.object({
  chainId: z.coerce.number().int().positive(),
  chainRpcUrl: z.string().url(),
  contractAddress: z.string().optional(),
  confirmations: z.coerce.number().int().nonnegative().default(1),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const EXAM_MANAGER_ABI = [
  "function admin() view returns (address)",
  "function phase() view returns (uint8)",
  "function totalSubmissions() view returns (uint16)",
  "function submitterCount() view returns (uint8)",
  "function isSubmitter(address) view returns (bool)",
  "function submitterSubject(address) view returns (uint8)",
  "function submitterEntity(address) view returns (uint8)",
  "function submitterQuestionCount(address) view returns (uint8)",
  "function submitterForSlot(uint8 subject,uint8 entity) view returns (address)",
  "function keyHolderKeysRegistered() view returns (bool)",
  "function commitments(address) view returns (bytes32)",
  "function hasCommitted(address) view returns (bool)",
  "function hasRevealed(address) view returns (bool)",
  "function revealCount() view returns (uint8)",
  "function anuSubmitted() view returns (bool)",
  "function anuValue() view returns (bytes32)",
  "function commitDeadline() view returns (uint64)",
  "function revealDeadline() view returns (uint64)",
  "function anuDeadline() view returns (uint64)",
  "function relayer() view returns (address)",
  "function keyOpenBefore() view returns (uint64)",
  "function keyCloseAfter() view returns (uint64)",
  "function seed() view returns (bytes32)",
  "function getSubmission(uint16 id) view returns ((address submitter,uint8 subject,uint8 entity,uint64 submittedAt,bytes32 ciphertextHash,bytes32[5] keyShareHashes,bytes32 plaintextCommitment,bytes16 objectId))",
  "function submitQuestions((bytes32 ciphertextHash,bytes32[5] keyShareHashes,bytes32 plaintextCommitment,bytes16 objectId,bytes[5] encryptedShares)[] questions) returns (uint16 firstId)",
  "event QuestionSubmitted(uint16 indexed id,address indexed submitter,uint8 subject,uint8 entity,bytes32 ciphertextHash,bytes16 objectId)",
  "event KeySharePublished(uint16 indexed questionId,uint8 indexed shareIndex,bytes encryptedShare)",
  "function getShiftQuestions(uint8 shiftId) view returns (uint16[75])",
  "function getPool(uint8 subject,uint8 entity) view returns (uint16[])",
  "function committee(uint256) view returns (address)",
  "function keyHolderPublicKeys(uint256) view returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function reveal(bytes32 secret)",
  "function submitAnu(bytes32 value,bytes raw)",
  "event Committed(address indexed member)",
  "event Revealed(address indexed member)",
  "event AnuSubmitted(bytes32 value,bytes raw)",
  "event SetsGenerated(bytes32 seed,bool anuUsed)",
  "event SubmissionsClosed(uint16 count)",
  "event SubmitterRegistered(address indexed submitter,uint8 subject,uint8 entity)",
  "event CommitteeRegistered(address[5] members)",
  "event KeyHolderPublicKeysSet(bytes32[5] publicKeys)",
  "event RelayerSet(address indexed relayer)",
  "event ShiftSet(uint8 indexed shiftId,uint64 startTime,uint64 endTime)",
  "event CenterRegistered(address indexed center,uint8 indexed shiftId,bytes32 x25519PubKey)",
  "event RandomnessConfigured(uint64 commitDeadline,uint64 revealDeadline,uint64 anuDeadline)",
  "event SubmissionsOpened()",
  "event CenterRevoked(address indexed center)",
  "event ShiftRescheduled(uint8 indexed shiftId,uint64 startTime,uint64 endTime)",
  "event ExamClosed(uint64 lastShiftEndTime)",
  "function centers(address) view returns (bool registered,bool revoked,uint8 shiftId,bytes32 x25519PubKey)",
  "function shifts(uint8) view returns (uint64 startTime,uint64 endTime,bool keysReleased)",
  "function requestKeys()",
  "function registerSubmitter(address account,uint8 subject,uint8 entity)",
  "function registerCommittee(address[5] members)",
  "function setKeyHolderPublicKeys(bytes32[5] publicKeys)",
  "function setRelayer(address account)",
  "function setShift(uint8 shiftId,uint64 startTime,uint64 endTime)",
  "function registerCenter(address account,uint8 shiftId,bytes32 x25519PubKey)",
  "function configureRandomness(uint64 commitAt,uint64 revealAt,uint64 anuAt)",
  "function openSubmissions()",
  "function closeSubmissions()",
  "function generateSets()",
  "function revokeCenter(address account)",
  "function rescheduleShift(uint8 shiftId,uint64 startTime,uint64 endTime)",
  "function finalizeExam()",
  "event KeyRequested(address indexed center,uint8 indexed shiftId,uint32 count)",
] as const;

export function createExamManager(address: string, runner: Provider | Signer): Contract {
  return new Contract(address, EXAM_MANAGER_ABI, runner);
}

export function loadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  return runtimeConfigSchema.parse({
    chainId: env.CHAIN_ID,
    chainRpcUrl: env.CHAIN_RPC_URL,
    contractAddress: env.CONTRACT_ADDRESS ? getAddress(env.CONTRACT_ADDRESS) : undefined,
    confirmations: env.CONFIRMATIONS,
  });
}
