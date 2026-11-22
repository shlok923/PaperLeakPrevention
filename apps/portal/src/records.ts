import { collectRecords, type ExamRecords } from "@eplp/protocol";
import type { Exam } from "./exam.tsx";

export async function collectReleased(
    exam: Exam,
    onWait: (shifts: number[]) => void,
    tries = 15,
): Promise<ExamRecords> {
    const t = exam.info.config.threshold;
    for (let i = 0; ; i++) {
        const records = await collectRecords(
            exam.client,
            exam.info,
            exam.store,
            exam.dep.custodianUrls,
        );
        const waiting = [
            ...new Set(
                records.sheets
                    .filter((g) => g.sheets.length)
                    .map((g) => g.shift),
            ),
        ].filter((shift) => {
            const byQid = records.released.get(shift);
            return (
                !byQid ||
                byQid.size === 0 ||
                [...byQid.values()].some((shares) => shares.length < t)
            );
        });
        if (!waiting.length || i >= tries) return records;
        onWait(waiting);
        await new Promise((r) => setTimeout(r, 2000));
    }
}
