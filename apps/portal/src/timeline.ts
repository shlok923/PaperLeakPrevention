import {
    roundTimeMs,
    type ChainInfo,
    type ExamConfig,
    type Snapshot,
} from "@eplp/protocol";

export type Milestone =
    | { kind: "seal"; round: number }
    | { kind: "start"; shift: number; round: number; planned: number }
    | { kind: "end"; shift: number; round: number }
    | { kind: "answers"; round: number };

export interface Point {
    milestone: Milestone;
    atMs: number;
    reached: boolean;
    onChain: boolean;
}

export function milestones(cfg: ExamConfig, snapshot: Snapshot): Milestone[] {
    return [
        { kind: "seal", round: cfg.sealRound },
        ...snapshot.windows.flatMap((w, shift): Milestone[] => [
            {
                kind: "start",
                shift,
                round: w.start,
                planned: cfg.shifts[shift]!.startRound,
            },
            { kind: "end", shift, round: w.end },
        ]),
        { kind: "answers", round: cfg.answersRound },
    ];
}

export function timeline(
    cfg: ExamConfig,
    snapshot: Snapshot,
    drand: ChainInfo,
    drandRound: number,
    onChain: ReadonlySet<number>,
): Point[] {
    return milestones(cfg, snapshot).map((m) => ({
        milestone: m,
        atMs: roundTimeMs(drand, m.round),
        reached: drandRound >= m.round,
        onChain: onChain.has(m.round),
    }));
}

export const shiftName = (shift: number) => `Shift ${shift + 1}`;

export function milestoneTitle(m: Milestone): string {
    switch (m.kind) {
        case "seal":
            return "Sealing closes";
        case "start":
            return `${shiftName(m.shift)} opens`;
        case "end":
            return `${shiftName(m.shift)} closes`;
        case "answers":
            return "Answer key opens";
    }
}

export function milestoneMeaning(m: Milestone): string {
    switch (m.kind) {
        case "seal":
            return "Setter roots and custodian acknowledgments stop. The set of eligible questions is fixed.";
        case "start":
            return "drand signs this round. Its signature opens the time-lock, picks the paper from the pool and lets custodians release keys.";
        case "end":
            return "Terminals sign the answer sheets. Each center posts one response root on chain.";
        case "answers":
            return "Custodians release the answer-key shares, so results can be computed and checked.";
    }
}

export type Phase =
    | { kind: "sealing"; until: number }
    | { kind: "waiting"; shift: number; until: number }
    | { kind: "live"; shift: number; until: number }
    | { kind: "collecting"; until: number }
    | { kind: "scoring" }
    | { kind: "published" };

export function phaseOf(
    cfg: ExamConfig,
    snapshot: Snapshot,
    drandRound: number,
): Phase {
    if (snapshot.resultRoot) return { kind: "published" };
    if (drandRound < cfg.sealRound)
        return { kind: "sealing", until: cfg.sealRound };
    for (const [shift, w] of snapshot.windows.entries()) {
        if (drandRound < w.start)
            return { kind: "waiting", shift, until: w.start };
        if (drandRound < w.end) return { kind: "live", shift, until: w.end };
    }
    if (drandRound < cfg.answersRound)
        return { kind: "collecting", until: cfg.answersRound };
    return { kind: "scoring" };
}

export function phaseLine(p: Phase): string {
    switch (p.kind) {
        case "sealing":
            return `Setters can seal questions until round ${p.until}`;
        case "waiting":
            return `Sealed. ${shiftName(p.shift)} opens at round ${p.until}`;
        case "live":
            return `${shiftName(p.shift)} is running until round ${p.until}`;
        case "collecting":
            return `Answers stay sealed until round ${p.until}`;
        case "scoring":
            return "Answers are open. Results can be computed";
        case "published":
            return "Results are published on chain";
    }
}
