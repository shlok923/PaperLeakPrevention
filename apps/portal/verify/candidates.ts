import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TerminalSession, type PaperItem } from "@eplp/protocol";
import { demoQuestions, SUBJECTS } from "@eplp/cli/demo";
import { deployment, OUT, ROOT, step } from "./browser.ts";

interface Card {
    rollNo: string;
    checkInCode: string;
    shift: number;
    center: number;
}

const cardsPath = process.argv[2] ?? join(OUT, "admit-cards-ui.json");
const cards = JSON.parse(readFileSync(cardsPath, "utf8")) as Card[];
const dep = deployment();

const keyOf = (text: string, options: readonly string[]) =>
    `${text}|${[...options].sort().join("|")}`;
const answerKey = new Map<string, string>();
const physics = JSON.parse(
    readFileSync(join(ROOT, "examples/questions-physics.json"), "utf8"),
) as { text: string; options: string[]; correct: number }[];
for (const q of physics)
    answerKey.set(keyOf(q.text, q.options), q.options[q.correct]!);
const pools = Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[];
for (let i = 0; i < 6; i++)
    for (const q of demoQuestions(pools[Math.floor(i / 2)]!, 10, 1000 + i))
        answerKey.set(keyOf(q.text, q.options), q.options[q.correct]!);

const correct = (it: PaperItem) =>
    it.options.indexOf(answerKey.get(keyOf(it.text, it.options)) ?? "");

interface Sat {
    rollNo: string;
    checkInCode: string;
    shift: number;
    center: number;
    receiptCode: string;
    sheetHash: string;
    right: number;
    wrong: number;
    blank: number;
}

const sat: Sat[] = [];
const out = join(OUT, "receipts.json");

for (const shift of [...new Set(cards.map((c) => c.shift))].sort()) {
    const sitting = [0, 1].flatMap((center) =>
        cards
            .filter((c) => c.shift === shift && c.center === center)
            .slice(0, 2),
    );
    step(
        `shift ${shift + 1}: waiting until both gateways hold the sealed pool and this shift's allocation`,
    );
    for (;;) {
        const exams = await Promise.all(
            dep.gatewayUrls.map((u) =>
                TerminalSession.exam(u).catch(() => null),
            ),
        );
        if (exams.every((e) => e?.ready && (e.allocated[shift] ?? 0) > 0))
            break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    step(`shift ${shift + 1}: ${sitting.length} candidates check in`);
    const sessions = await Promise.all(
        sitting.map((c, k) =>
            TerminalSession.start(
                dep.gatewayUrls[c.center]!,
                shift,
                `T-${shift + 1}${c.center}${k}`,
                c.rollNo,
                c.checkInCode,
            ),
        ),
    );
    step(
        `shift ${shift + 1}: waiting for the start beacon (round ${sessions[0]!.window.start})`,
    );
    const papers = await Promise.all(sessions.map((s) => s.unlock()));
    for (const [k, s] of sessions.entries()) {
        const card = sitting[k]!;
        const items = papers[k]!.items;
        const careless = k % 2 === 0;
        let right = 0;
        let wrong = 0;
        let blank = 0;
        for (const [i, it] of items.entries()) {
            const key = correct(it);
            if (key < 0) throw new Error(`no key for "${it.text}"`);
            if (careless && i === 3) {
                blank++;
                continue;
            }
            const pick =
                careless && i === 1 ? (key + 1) % it.options.length : key;
            pick === key ? right++ : wrong++;
            s.answer(it.qid, pick, await s.latestRound());
        }
        const r = await s.submit(await s.latestRound());
        sat.push({
            ...card,
            receiptCode: r.receiptCode,
            sheetHash: r.sheetHash,
            right,
            wrong,
            blank,
        });
        console.log(
            `    ${card.rollNo} at center ${card.center + 1}: ${right} right, ${wrong} wrong, ${blank} blank; receipt ${r.receiptCode}`,
        );
    }
    writeFileSync(out, JSON.stringify(sat, null, 2));
}
step(`${sat.length} sheets submitted; receipts in ${out}`);
