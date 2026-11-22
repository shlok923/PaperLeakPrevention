import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
    allocationProof,
    allocationTree,
    candidateHash,
    canonicalJson,
    checkManifest,
    configHash,
    DevBeacon,
    eligibleQuestions,
    generateHpkeKeyPair,
    MerkleTree,
    open,
    openAnswer,
    openQuestion,
    openShares,
    optionOrder,
    publicKeyToEip2537,
    questionOrder,
    releasedQids,
    scoreSheet,
    seal,
    sealBatch,
    selectionSeed,
    shiftPlan,
    signatureToEip2537,
    toHex,
    validateConfig,
    verifyAllocation,
    verifyMerkleProof,
    type ExamConfig,
    type Hex,
    type Question,
    type SignedSheet,
} from "../src/index.ts";

const examId = `0x${"ab".repeat(32)}` as Hex;

function questions(tag: string, n: number): Question[] {
    return Array.from({ length: n }, (_, i) => ({
        text: `${tag} question ${i}`,
        options: [`${tag}${i}a`, `${tag}${i}b`, `${tag}${i}c`, `${tag}${i}d`],
        correct: (i % 4) as 0 | 1 | 2 | 3,
    }));
}

async function setup() {
    const beacon = new DevBeacon(
        DevBeacon.generateSecret(),
        Math.floor(Date.now() / 1000) - 1000,
        1,
    );
    const custodians = await Promise.all(
        [0, 1, 2].map(() => generateHpkeKeyPair()),
    );
    const setters = [
        privateKeyToAccount(generatePrivateKey()),
        privateKeyToAccount(generatePrivateKey()),
    ];
    const config: ExamConfig = {
        title: "Unit exam",
        pools: ["Physics"],
        setters: setters.map((s) => ({
            account: s.address,
            pool: 0,
            perShift: 3,
        })),
        custodians: custodians
            .map((c, i) => ({
                account: privateKeyToAccount(generatePrivateKey()).address,
                hpkeKey: c.publicKey,
                i,
            }))
            .map(({ account, hpkeKey }) => ({ account, hpkeKey })),
        threshold: 2,
        centers: [
            {
                account: privateKeyToAccount(generatePrivateKey()).address,
                name: "Hall A",
            },
        ],
        shifts: [
            { startRound: 100, endRound: 200, perPool: [3], reserve: false },
            { startRound: 300, endRound: 400, perPool: [3], reserve: false },
        ],
        spare: 1,
        lateEntryRounds: 10,
        sealRound: 50,
        answersRound: 500,
        marksCorrect: 4,
        marksWrong: -1,
        clientHash: `0x${"00".repeat(32)}`,
        drand: {
            publicKey: `0x${beacon.info.public_key}`,
            publicKeyG2: publicKeyToEip2537(beacon.info.public_key),
            genesisTime: beacon.info.genesis_time,
            period: 1,
            chainHash: `0x${beacon.info.hash}`,
        },
    };
    return { beacon, custodians, setters, config };
}

describe("encoding and merkle", () => {
    it("canonical JSON sorts keys and drops undefined", () => {
        expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe(
            '{"a":[true,null],"b":1}',
        );
    });

    it("merkle proofs verify for every leaf and fail when tampered", () => {
        for (const n of [1, 2, 3, 5, 8, 13]) {
            const leaves = Array.from({ length: n }, (_, i) =>
                toHex(new Uint8Array(32).fill(i + 1)),
            );
            const tree = new MerkleTree(leaves);
            leaves.forEach((leaf, i) => {
                expect(
                    verifyMerkleProof(tree.root, leaf, tree.proof(i), n),
                ).toBe(true);
                expect(
                    verifyMerkleProof(
                        tree.root,
                        leaf,
                        tree.proof((i + 1) % n),
                        n,
                    ),
                ).toBe(n === 1);
            });
        }
    });
});

describe("config", () => {
    it("accepts a sound config and explains a broken one", async () => {
        const { config } = await setup();
        expect(validateConfig(config)).toEqual([]);
        expect(configHash(config)).toMatch(/^0x[0-9a-f]{64}$/);
        const broken = { ...config, threshold: 4, sealRound: 150 };
        expect(validateConfig(broken)).toEqual(
            expect.arrayContaining([
                "threshold must be between 2 and the custodian count",
                "sealing must close before the first shift",
            ]),
        );
    });
});

describe("hpke", () => {
    it("seals to a custodian and only that key opens it", async () => {
        const a = await generateHpkeKeyPair();
        const b = await generateHpkeKeyPair();
        const aad = new Uint8Array([7]);
        const box = await seal(a.publicKey, new Uint8Array([1, 2, 3]), aad);
        expect([...(await open(a.privateKey, box, aad))]).toEqual([1, 2, 3]);
        await expect(open(b.privateKey, box, aad)).rejects.toThrow();
        await expect(
            open(a.privateKey, box, new Uint8Array([8])),
        ).rejects.toThrow();
    });
});

describe("full protocol in memory", () => {
    it("seals, selects at the beacon, opens with t custodians, and scores", async () => {
        const { beacon, custodians, setters, config } = await setup();
        const info = beacon.info;

        const batches = await Promise.all(
            setters.map((s, i) =>
                sealBatch(
                    config,
                    info,
                    examId,
                    s.address,
                    questions(`S${i}`, 6),
                ),
            ),
        );
        for (const b of batches) checkManifest(b.manifest, b.root);
        await expect(
            sealBatch(
                config,
                info,
                examId,
                setters[0]!.address,
                questions("x", 5),
            ),
        ).rejects.toThrow(/exactly 6/);

        const bundles = new Map(
            batches.flatMap((b) =>
                b.bundles.map((bundle, i) => [
                    b.manifest.leaves[i]!.bundleHash,
                    bundle,
                ]),
            ),
        );
        const eligible = eligibleQuestions(
            config,
            batches.map((b) => b.manifest),
        );
        expect(eligible.size).toBe(12);

        const held = await Promise.all(
            custodians.map(async (c, j) => {
                const m = new Map<Hex, { shareQ: Hex; shareA: Hex }>();
                for (const q of eligible.values())
                    m.set(
                        q.qid,
                        await openShares(
                            bundles.get(q.leaf.bundleHash)!,
                            j,
                            c.privateKey,
                        ),
                    );
                return m;
            }),
        );

        const start = beacon.sign(100);
        const seed = selectionSeed(
            examId,
            0,
            signatureToEip2537(start.signature),
        );
        const plan = shiftPlan(config, eligible, 0, seed);
        expect(plan[0]!.candidates).toHaveLength(4);
        expect(
            new Set(
                plan[0]!.candidates.map((q) => eligible.get(q)!.leaf.shift),
            ),
        ).toEqual(new Set([0]));
        const otherSeed = selectionSeed(
            examId,
            0,
            signatureToEip2537(beacon.sign(101).signature),
        );
        expect(
            shiftPlan(config, eligible, 0, otherSeed)[0]!.candidates,
        ).not.toEqual(plan[0]!.candidates);

        const qids = releasedQids(plan);
        const opened = await Promise.all(
            qids.map(async (qid) => {
                const q = eligible.get(qid)!;
                const bundle = bundles.get(q.leaf.bundleHash)!;
                const shares = [
                    held[0]!.get(qid)!.shareQ,
                    held[2]!.get(qid)!.shareQ,
                ];
                return {
                    qid,
                    payload: await openQuestion(
                        bundle,
                        q.leaf,
                        start,
                        info,
                        shares,
                        2,
                    ),
                };
            }),
        );
        expect(opened.every((o) => o.payload.text.includes("question"))).toBe(
            true,
        );
        expect(JSON.stringify(opened)).not.toContain('"correct"');

        const first = eligible.get(qids[0]!)!;
        const firstBundle = bundles.get(first.leaf.bundleHash)!;
        await expect(
            openQuestion(
                firstBundle,
                first.leaf,
                start,
                info,
                [held[0]!.get(qids[0]!)!.shareQ],
                2,
            ),
        ).rejects.toThrow(/need 2/);
        await expect(
            openQuestion(
                firstBundle,
                first.leaf,
                beacon.sign(99),
                info,
                [
                    held[0]!.get(qids[0]!)!.shareQ,
                    held[1]!.get(qids[0]!)!.shareQ,
                ],
                2,
            ),
        ).rejects.toThrow();
        const bad = `0x${"00".repeat(33)}` as Hex;
        const viaThird = await openQuestion(
            firstBundle,
            first.leaf,
            start,
            info,
            [
                bad,
                held[1]!.get(qids[0]!)!.shareQ,
                held[2]!.get(qids[0]!)!.shareQ,
            ],
            2,
        );
        expect(viaThird.text).toBe(opened[0]!.payload.text);

        const paper = plan.flatMap((p) => p.candidates.slice(0, p.count));
        const c1 = candidateHash(examId, "R001", "CODE1");
        const c2 = candidateHash(examId, "R002", "CODE2");
        expect(new Set(questionOrder(seed, c1, paper))).toEqual(new Set(paper));
        const orders = new Set(
            ["R003", "R004", "R005", "R006", "R007", "R008"].map((r) =>
                questionOrder(
                    seed,
                    candidateHash(examId, r, "C"),
                    paper,
                ).join(),
            ),
        );
        expect(orders.size).toBeGreaterThan(1);
        expect(questionOrder(seed, c2, [...paper].reverse())).toEqual(
            questionOrder(seed, c2, paper),
        );
        expect([...optionOrder(seed, c1, paper[0]!)].sort()).toEqual([
            0, 1, 2, 3,
        ]);

        const answersBeacon = beacon.sign(500);
        const key = new Map<Hex, number>();
        for (const qid of paper) {
            const q = eligible.get(qid)!;
            const ans = await openAnswer(
                bundles.get(q.leaf.bundleHash)!,
                q.leaf,
                answersBeacon,
                info,
                [held[1]!.get(qid)!.shareA, held[2]!.get(qid)!.shareA],
                2,
            );
            key.set(qid, ans.correct);
        }
        await expect(
            openAnswer(
                firstBundle,
                first.leaf,
                start,
                info,
                [
                    held[1]!.get(qids[0]!)!.shareA,
                    held[2]!.get(qids[0]!)!.shareA,
                ],
                2,
            ),
        ).rejects.toThrow();

        const sheet: SignedSheet = {
            sheet: {
                examId,
                shift: 0,
                center: 0,
                candidateHash: c1,
                session: setters[0]!.address,
                answers: paper.map(
                    (qid, i) =>
                        [
                            qid,
                            i === 0
                                ? null
                                : i === 1
                                  ? (key.get(qid)! + 1) % 4
                                  : key.get(qid)!,
                        ] as [Hex, number | null],
                ),
                logHead: `0x${"00".repeat(32)}`,
                submittedRound: 190,
            },
            signature: "0x",
        };
        const result = scoreSheet(sheet, key, { correct: 4, wrong: -1 });
        expect(result).toMatchObject({
            correct: 1,
            wrong: 1,
            unanswered: 1,
            score: 3,
        });
    }, 60_000);

    it("allocation proofs bind a candidate to one center", () => {
        const entries = ["A", "B", "C"].map((r, i) => ({
            candidateHash: candidateHash(examId, r, "X"),
            center: i % 2,
        }));
        const alloc = { examId, shift: 0, entries };
        const root = allocationTree(alloc).root;
        const p = allocationProof(alloc, entries[2]!.candidateHash, 0)!;
        expect(verifyAllocation(root, entries[2]!, p)).toBe(true);
        expect(verifyAllocation(root, { ...entries[2]!, center: 1 }, p)).toBe(
            false,
        );
        expect(allocationProof(alloc, entries[2]!.candidateHash, 1)).toBeNull();
    });
});
