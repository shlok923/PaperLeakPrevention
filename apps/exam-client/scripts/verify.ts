import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@eplp/node-kit/root";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
    candidateHash,
    getJson,
    TerminalSession,
    type Hex,
    type SignedSheet,
} from "@eplp/protocol";

interface AdmitCard {
    rollNo: string;
    checkInCode: string;
    shift: number;
    center: number;
}

const BASE = process.env.TERMINAL_URL ?? "http://127.0.0.1:8900";
const CARDS =
    process.env.ADMIT_CARDS ??
    join(repoRoot, ".data-ui-exam/admit-cards.json");
const SHOTS = process.env.SHOTS ?? join(tmpdir(), "eplp-exam-client-shots");
const PIN = process.env.PROCTOR_PIN ?? "2468";
mkdirSync(SHOTS, { recursive: true });

const cards = JSON.parse(readFileSync(CARDS, "utf8")) as AdmitCard[];
const hallA = cards.filter((c) => c.shift === 0 && c.center === 0);
const card = hallA[Number(process.env.CARD ?? 0)]!;
const autoCard = process.env.AUTO_SUBMIT
    ? hallA[Number(process.env.CARD ?? 0) + 1]!
    : null;
const examId = (await TerminalSession.exam(BASE)).examId;
const candidate = candidateHash(examId, card.rollNo, card.checkInCode);
const storedAnswers = async (who: Hex) =>
    (
        await getJson<SignedSheet>(`${BASE}/api/sheet/0/${who}`)
    ).sheet.answers.filter(([, choice]) => choice !== null).length;
const candidateRow = (page: Page) =>
    page.locator(`tbody tr:has(td[title="${candidate}"])`);
const t0 = Date.now();
const step = (m: string) =>
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let shotNo = 0;
const shot = async (page: Page, name: string) => {
    const path = join(
        SHOTS,
        `${String(++shotNo).padStart(2, "0")}-${name}.png`,
    );
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => undefined)),
        ),
    );
    await page.screenshot({ path });
    console.log(`        shot ${path}`);
    if (process.env.COPY_DUMP)
        appendFileSync(
            process.env.COPY_DUMP,
            `## ${name}\n\n${await page.evaluate(() => document.body.innerText)}\n\n`,
        );
};

const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
});
const newTerminal = async (
    viewport = { width: 1440, height: 900 },
): Promise<{ ctx: BrowserContext; page: Page }> => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.accept());
    page.on("pageerror", (e) =>
        console.log(`        page error: ${e.message}`),
    );
    return { ctx, page };
};

async function nameTerminal(page: Page, id: string) {
    await page.goto(`${BASE}/`);
    await page.getByLabel("Terminal ID").waitFor();
    await page.getByLabel("Terminal ID").fill(id);
    await page.getByRole("button", { name: "Save terminal" }).click();
    await page.getByRole("heading", { name: "Check in" }).waitFor();
}

async function checkIn(page: Page, rollNo: string, code: string) {
    await page.waitForFunction(
        () =>
            !(
                document.querySelector(
                    "form button[type=submit]",
                ) as HTMLButtonElement | null
            )?.disabled,
        null,
        {
            timeout: 180_000,
        },
    );
    await page.getByLabel("Roll number").fill(rollNo);
    await page.getByLabel("Check-in code").fill(code);
    await page.getByRole("button", { name: "Check in", exact: true }).click();
}

const alertText = async (page: Page) =>
    (await page.getByRole("alert").first().textContent({ timeout: 15_000 })) ??
    "";
const legendCount = async (page: Page, status: string) =>
    Number(
        await page
            .locator(`.legend [data-status=${status}] .num`)
            .textContent(),
    );
const waitForPaper = (page: Page) =>
    page.getByText(/^Question 1 of \d+/).waitFor({ timeout: 240_000 });

async function proctorApprove(page: Page, terminal: string) {
    await page.reload();
    await page.getByLabel("Proctor PIN").fill(PIN);
    await page.getByRole("button", { name: "Open console" }).click();
    const row = candidateRow(page)
        .filter({ hasText: terminal })
        .filter({ hasText: "Sitting" });
    await row.getByRole("button", { name: "Approve transfer" }).click();
    await row
        .getByRole("button", { name: `Approve move from ${terminal}` })
        .click();
    await candidateRow(page).filter({ hasText: "Transfer approved" }).waitFor();
}

try {
    const a = await newTerminal();
    step(`terminal T-01 at ${BASE}, candidate ${card.rollNo}`);
    await a.page.goto(`${BASE}/`);
    await a.page.getByLabel("Terminal ID").waitFor();
    await shot(a.page, "terminal-setup");
    await nameTerminal(a.page, "T-01");
    await shot(a.page, "check-in");

    step("wrong check-in code is refused in plain language");
    await checkIn(a.page, card.rollNo, "WRONG1");
    assert.match(await alertText(a.page), /do not match a seat in this hall/);
    await shot(a.page, "refused-403");

    step("check in; the waiting room counts down to the start round");
    await a.page.getByLabel("Check-in code").fill(card.checkInCode);
    await a.page.getByRole("button", { name: "Check in", exact: true }).click();
    await a.page.getByText("The paper does not exist yet.").waitFor();
    await shot(a.page, "waiting-room");

    const auto = autoCard && (await newTerminal({ width: 1366, height: 768 }));
    if (auto && autoCard) {
        step(
            `second candidate ${autoCard.rollNo} checks in at T-02 and will be left to time out`,
        );
        await nameTerminal(auto.page, "T-02");
        await checkIn(auto.page, autoCard.rollNo, autoCard.checkInCode);
        await auto.page.getByText("The paper does not exist yet.").waitFor();
    }

    step("unlock at T");
    await a.page
        .getByRole("heading", { name: "Opening your paper." })
        .waitFor({ timeout: 240_000 });
    await shot(a.page, "unlocking");
    await waitForPaper(a.page);
    const total = Number(
        (await a.page.getByText(/^Question 1 of \d+/).textContent())!.match(
            /of (\d+)/,
        )![1],
    );
    await shot(a.page, "exam-first-question");
    if (auto) {
        await waitForPaper(auto.page);
        await auto.page.locator(".option").nth(2).click();
        await auto.page.getByRole("button", { name: "Next question" }).click();
        await auto.page.locator(".option").nth(0).click();
        await shot(auto.page, "exam-1366x768");
    }

    step("answer five questions, mark two for review");
    const options = a.page.locator(".option");
    for (const [i, pickOption] of [1, 0, 3, 2, 1].entries()) {
        await options.nth(pickOption).click();
        if (i === 2 || i === 3)
            await a.page
                .getByRole("button", { name: "Mark for review" })
                .click();
        await a.page.getByRole("button", { name: "Next question" }).click();
    }
    assert.equal(await legendCount(a.page, "answered"), 5);
    assert.equal(await legendCount(a.page, "marked"), 2);
    assert.equal(await legendCount(a.page, "unanswered"), 1);
    await a.page
        .getByText(/^Saved \d\d:\d\d:\d\d/)
        .waitFor({ timeout: 15_000 });
    await shot(a.page, "exam-answered");

    step(
        "reload mid-exam: the session keys are gone, so the terminal needs a proctor transfer",
    );
    await a.page.reload();
    await a.page.getByText(/This terminal restarted while/).waitFor();
    assert.equal(
        await a.page.getByLabel("Roll number").inputValue(),
        card.rollNo,
    );
    await shot(a.page, "after-reload");
    await checkIn(a.page, card.rollNo, card.checkInCode);
    assert.match(
        await alertText(a.page),
        /already checked in at terminal T-01/,
    );
    await shot(a.page, "refused-409");

    step("proctor approves the transfer");
    const p = await newTerminal();
    await p.page.goto(`${BASE}/proctor`);
    await p.page.getByLabel("Proctor PIN").waitFor();
    await shot(p.page, "proctor-pin");
    await p.page.getByLabel("Proctor PIN").fill(PIN);
    await p.page.getByRole("button", { name: "Open console" }).click();
    await p.page.locator("tbody tr").first().waitFor();
    await shot(p.page, "proctor-console");
    const row = candidateRow(p.page).filter({ hasText: "Sitting" });
    await row.getByRole("button", { name: "Approve transfer" }).click();
    await shot(p.page, "proctor-confirm");
    await row.getByRole("button", { name: "Approve move from T-01" }).click();
    await candidateRow(p.page)
        .filter({ hasText: "Transfer approved" })
        .waitFor();

    step("same terminal checks in again; saved answers come back");
    await a.page.getByRole("button", { name: "Check in", exact: true }).click();
    await waitForPaper(a.page);
    await a.page.getByText(/5 saved answers were restored/).waitFor();
    assert.equal(await legendCount(a.page, "answered"), 5);
    await shot(a.page, "restored-after-reload");
    await a.page.locator(".tile").nth(5).click();
    await a.page.locator(".option").nth(2).click();
    await a.page
        .getByText(/^Saved \d\d:\d\d:\d\d/)
        .waitFor({ timeout: 15_000 });

    step(
        "terminal T-01 fails; candidate moves to a spare terminal T-07 in a new browser",
    );
    const b = await newTerminal();
    await nameTerminal(b.page, "T-07");
    await checkIn(b.page, card.rollNo, card.checkInCode);
    assert.match(
        await alertText(b.page),
        /already checked in at terminal T-01/,
    );
    await proctorApprove(p.page, "T-01");
    await b.page.getByRole("button", { name: "Check in", exact: true }).click();
    await waitForPaper(b.page);
    await b.page.getByText(/6 saved answers were restored/).waitFor();
    await shot(b.page, "transfer-T-07");

    step("the replaced terminal can no longer submit");
    await a.page.getByRole("button", { name: "Submit answers" }).click();
    await a.page
        .getByRole("dialog")
        .getByRole("button", { name: "Submit answers" })
        .click();
    await a.page
        .getByText("This terminal no longer holds your session.")
        .waitFor();
    await shot(a.page, "replaced-terminal-refused");
    await a.page.getByRole("button", { name: "Clear this terminal" }).click();
    await a.page.getByRole("heading", { name: "Check in" }).waitFor();

    step("answer one more and submit from T-07");
    await b.page.locator(".tile").nth(6).click();
    await b.page.locator(".option").nth(0).click();
    await b.page.getByRole("button", { name: "Submit answers" }).click();
    await b.page.getByRole("dialog").getByText(`7 of ${total}`).waitFor();
    await shot(b.page, "submit-dialog");
    await b.page
        .getByRole("dialog")
        .getByRole("button", { name: "Submit answers" })
        .click();
    await b.page
        .getByRole("heading", { name: "Your answers are in." })
        .waitFor();
    const code = (await b.page
        .locator(".code")
        .getAttribute("aria-label"))!.replaceAll(" ", "");
    assert.match(code, /^[0-9A-F]{10}$/);
    assert.equal(
        await storedAnswers(candidate),
        7,
        "the gateway holds a sheet with all 7 answers",
    );
    await shot(b.page, "receipt");

    step("proctor sees two replaced sessions and one submitted");
    await p.page.reload();
    await p.page.getByLabel("Proctor PIN").fill(PIN);
    await p.page.getByRole("button", { name: "Open console" }).click();
    await candidateRow(p.page)
        .filter({ hasText: "T-07" })
        .filter({ hasText: "Submitted" })
        .waitFor();
    assert.equal(
        await candidateRow(p.page)
            .filter({ hasText: "Moved to another terminal" })
            .count(),
        2,
    );
    await shot(p.page, "proctor-final");

    if (auto) {
        step("T-02 is left alone until the end time and submits by itself");
        await auto.page
            .getByText(/Time ended\. Submitted automatically/)
            .waitFor({ timeout: 15 * 60_000 });
        assert.match(
            (await auto.page.locator(".tally--rows").textContent()) ?? "",
            /Answered2 of/,
        );
        assert.equal(
            await storedAnswers(
                candidateHash(examId, autoCard!.rollNo, autoCard!.checkInCode),
            ),
            2,
        );
        await shot(auto.page, "auto-submitted");
    }

    step(
        `PASSED: receipt ${code}, ${total} questions, screenshots in ${SHOTS}`,
    );
} catch (e) {
    console.error(`\nFAILED: ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
} finally {
    await browser.close();
}
