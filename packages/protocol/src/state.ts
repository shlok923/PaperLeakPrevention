import type { Address } from "viem";
import type { Hex } from "./bytes.ts";
import { leafId, manifestRoot, type Leaf, type Manifest } from "./bundle.ts";
import type { ExamConfig } from "./config.ts";
import { poolOrder } from "./shuffle.ts";

export interface EligibleQuestion {
    qid: Hex;
    setter: Address;
    pool: number;
    leaf: Leaf;
}

/**
 * The eligible question set: every slot of every setter whose final on-chain root
 * was acknowledged by `threshold` custodians before sealing. Callers pass only the
 * manifests of eligible setters, each checked against its on-chain root.
 */
export function eligibleQuestions(
    config: ExamConfig,
    manifests: readonly Manifest[],
): Map<Hex, EligibleQuestion> {
    const out = new Map<Hex, EligibleQuestion>();
    for (const m of manifests) {
        const cfg = config.setters.find(
            (s) => s.account.toLowerCase() === m.setter.toLowerCase(),
        );
        if (!cfg) throw new Error(`manifest from unknown setter ${m.setter}`);
        for (const leaf of m.leaves) {
            const qid = leafId(m.examId, cfg.account, leaf);
            out.set(qid, { qid, setter: cfg.account, pool: cfg.pool, leaf });
        }
    }
    return out;
}

export function checkManifest(m: Manifest, onChainRoot: Hex): void {
    if (manifestRoot(m).toLowerCase() !== onChainRoot.toLowerCase())
        throw new Error(
            `manifest for ${m.setter} does not match its on-chain root`,
        );
}

export interface PoolPlan {
    pool: number;
    count: number;
    /** Tried in this order; the first `count` that open and verify make the paper. */
    candidates: Hex[];
}

/** Which questions a shift opens, per pool. Custodians release exactly these. */
export function shiftPlan(
    config: ExamConfig,
    questions: ReadonlyMap<Hex, EligibleQuestion>,
    shift: number,
    seed: Hex,
): PoolPlan[] {
    const cfg = config.shifts[shift];
    if (!cfg) throw new Error(`no shift ${shift}`);
    return cfg.perPool.map((count, pool) => {
        const eligible = [...questions.values()]
            .filter((q) => q.pool === pool && q.leaf.shift === shift)
            .map((q) => q.qid);
        return {
            pool,
            count,
            candidates: poolOrder(seed, pool, eligible).slice(
                0,
                count + config.spare,
            ),
        };
    });
}

export const releasedQids = (plan: readonly PoolPlan[]): Hex[] =>
    plan.flatMap((p) => p.candidates);
