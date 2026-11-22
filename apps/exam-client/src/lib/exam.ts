import {
    chainInfoFromConfig,
    roundAt,
    roundTimeMs,
    TerminalSession,
    type GatewayExam,
} from "@eplp/protocol";

export const API_BASE = location.origin;

export const fetchExam = (): Promise<GatewayExam> =>
    TerminalSession.exam(API_BASE);

export const currentRound = (exam: GatewayExam): number =>
    exam.drandRound || roundAt(chainInfoFromConfig(exam.config), Date.now());

export const roundTime = (exam: GatewayExam, round: number): number =>
    roundTimeMs(chainInfoFromConfig(exam.config), round);

export type ShiftPick =
    | {
          status: "live" | "upcoming";
          shift: number;
          start: number;
          end: number;
          lateEntryEnd: number;
      }
    | { status: "over" };

export function pickShift(
    exam: GatewayExam,
    round = currentRound(exam),
): ShiftPick {
    const { lateEntryRounds, shifts } = exam.config;
    let next: ShiftPick = { status: "over" };
    for (const [shift, w] of exam.windows.entries()) {
        if (shifts[shift]?.reserve) continue;
        const lateEntryEnd = Math.min(w.start + lateEntryRounds, w.end);
        if (round >= w.start && round <= w.end)
            return { status: "live", shift, ...w, lateEntryEnd };
        if (round < w.start && (next.status === "over" || w.start < next.start))
            next = { status: "upcoming", shift, ...w, lateEntryEnd };
    }
    return next;
}

export const shiftLabel = (shift: number): string => `Shift ${shift + 1}`;
