import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { createPublicClient, http, type PublicClient } from "viem";
import { candidateHash, readExam, validateConfig } from "@eplp/protocol";
import {
    deployment,
    launch,
    openPage,
    OUT,
    portalUrl,
    ROOT,
    shot,
    step,
} from "./browser.ts";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(deployment().rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result: T };
    return body.result;
}

const nonceOf = async (address: string) =>
    Number(await rpc<string>("eth_getTransactionCount", [address, "latest"]));

async function open(page: Page, path: string): Promise<void> {
    await page.goto(portalUrl(path), { waitUntil: "networkidle" });
    await page.waitForSelector("main#top.is-tool, main#top.is-overview", {
        timeout: 30_000,
    });
}

async function signIn(page: Page, label: string): Promise<string> {
    await page
        .getByRole("button", {
            name: /^(Sign in|Exam authority|Setter|Custodian|Center|No role)/,
        })
        .first()
        .click();
    const pick = page.locator(".idpanel__pick", { hasText: label }).first();
    const address = (await pick.locator(".hash").getAttribute("title")) ?? "";
    await pick.click();
    await page.locator(".nav__identity", { hasText: label }).waitFor();
    return address;
}

async function setter(page: Page) {
    step("setter: sign in as Setter 1 with the demo identity");
    await open(page, "/setter");
    const address = await signIn(page, "Setter 1, Physics");
    await page
        .getByRole("heading", { name: "Seal your Physics questions" })
        .waitFor();

    step("setter: a broken file shows each question's problems");
    const broken = join(OUT, "questions-broken.json");
    writeFileSync(
        broken,
        JSON.stringify([
            {
                text: "Speed of light?",
                options: ["c", "2c", "c/2", "0"],
                correct: 0,
            },
            { text: "", options: ["a", "b", "c"], correct: 1 },
            {
                text: "Unit of force?",
                options: ["newton", "joule", "watt", "pascal"],
                correct: 7,
            },
        ]),
    );
    await page.setInputFiles("#questions-file", broken);
    const problems = page.getByRole("alert", { name: "Problems in the file" });
    await problems.waitFor();
    const text = await problems.innerText();
    assert.match(text, /Question 2.*text is required/s);
    assert.match(text, /Question 2.*exactly four non-empty options/s);
    assert.match(text, /Question 3.*correct must be 0, 1, 2 or 3/s);
    assert.match(text, /need exactly 10 questions\. This file has 3/);
    assert.equal(
        await page.getByRole("button", { name: /^Seal and/ }).isDisabled(),
        true,
    );
    await shot(page, "02-setter-invalid-file", true);

    step("setter: the sample Physics file passes and previews");
    await page.setInputFiles(
        "#questions-file",
        join(ROOT, "examples/questions-physics.json"),
    );
    await page.getByText("10 questions pass the schema").waitFor();
    assert.equal(await page.locator(".preview .question").count(), 10);
    await shot(page, "03-setter-preview");

    step(
        "setter: an overview tab stays open to watch the table change without a reload",
    );
    const watch = await page.context().newPage();
    await open(watch, "/");
    const row = watch.locator("#setters tbody tr").first();
    await row.scrollIntoViewIfNeeded();
    assert.match(await row.innerText(), /Not submitted/);
    await shot(watch, "01b-overview-setter-pending");

    const before = await nonceOf(address);
    step(`setter: seal and submit (account nonce ${before})`);
    await page
        .getByRole("button", { name: "Seal and submit 10 questions" })
        .click();
    await page
        .getByText("The store checked each one against your on-chain root")
        .waitFor({ timeout: 120_000 });
    const after = await nonceOf(address);
    assert.equal(after, before + 1, "exactly one transaction from the setter");
    const txLine = await page.locator(".tx").innerText();
    assert.match(txLine, /The only transaction this account has sent/);
    console.log(`    ${txLine}`);
    await shot(page, "04-setter-submitted");

    step("setter: custodians acknowledge live");
    await page.waitForFunction(
        () => document.querySelectorAll(".ack-list .glyph--done").length >= 3,
        null,
        { timeout: 90_000 },
    );
    await page.getByText("3 of 3 so far").waitFor({ timeout: 10_000 });
    await shot(page, "05-setter-acknowledged", true);

    await row
        .locator(".state", { hasText: "Eligible" })
        .waitFor({ timeout: 15_000 });
    assert.match(await row.innerText(), /3 of 2/);
    await row.scrollIntoViewIfNeeded();
    await shot(watch, "05b-overview-setter-eligible-live");
    await watch.close();
}

export const ADMIT_CARDS = join(OUT, "admit-cards-ui.json");

async function authority(page: Page) {
    step("authority: sign in with the demo authority identity");
    await open(page, "/authority");
    await signIn(page, "Exam authority");
    await page.getByRole("heading", { name: "Candidate allocation" }).waitFor();

    step(
        "authority: three candidates per center and shift, codes made in the browser",
    );
    await page.getByLabel("Candidates per center and shift").fill("3");
    await page.getByRole("button", { name: "Fill in roll numbers" }).click();
    await page.getByRole("button", { name: "Create check-in codes" }).click();
    await page.locator(".admit").first().waitFor();
    assert.equal(await page.locator(".admit").count(), 12);

    for (const shift of [1, 2]) {
        step(`authority: post the Shift ${shift} allocation`);
        const card = page.locator(".post-card", { hasText: `Shift ${shift}:` });
        await card
            .getByRole("button", { name: `Post Shift ${shift} allocation` })
            .click();
        await card
            .locator(".ok-line, .refusal")
            .first()
            .waitFor({ timeout: 60_000 });
        await card
            .getByText("On chain and in the store")
            .waitFor({ timeout: 15_000 });
    }
    await page.locator("#allocation").scrollIntoViewIfNeeded();
    await shot(page, "06-authority-allocation", true);

    step("authority: download the admit cards");
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download admit cards" }).click(),
    ]);
    await download.saveAs(ADMIT_CARDS);
    const cards = JSON.parse(readFileSync(ADMIT_CARDS, "utf8")) as {
        rollNo: string;
        checkInCode: string;
    }[];
    assert.equal(cards.length, 12);
    console.log(`    ${cards.length} admit cards saved to ${ADMIT_CARDS}`);

    step(
        "authority: moving Shift 2 earlier is refused with the contract's own error",
    );
    await page.getByLabel("Shift", { exact: true }).selectOption("1");
    const start = Number(
        await page.getByLabel("New start round").getAttribute("placeholder"),
    );
    await page.getByLabel("New start round").fill(String(start - 10));
    await page.getByRole("button", { name: "Postpone Shift 2" }).click();
    const refusal = page.locator("#schedule .refusal");
    await refusal.waitFor({ timeout: 30_000 });
    assert.match(await refusal.innerText(), /InvalidWindow\(\)/);
    await refusal.scrollIntoViewIfNeeded();
    await shot(page, "07-authority-postpone-refused");
}

async function overview(page: Page) {
    step("overview: the drand clock moves with no reload");
    await open(page, "/");
    const roundNow = async () =>
        Number((await page.locator(".hero .win__meta b").innerText()).trim());
    const r0 = await roundNow();
    await page.waitForTimeout(4500);
    const r1 = await roundNow();
    assert.ok(r1 > r0, `drand round advanced on screen (${r0} -> ${r1})`);
    console.log(`    drand round on screen ${r0} -> ${r1}`);
    const tag = process.env.SHOT_TAG ?? "now";
    await shot(page, `overview-${tag}-hero`);
    await page.locator("#timeline").scrollIntoViewIfNeeded();
    await shot(page, `overview-${tag}-timeline`);
    await page.locator("#centers").scrollIntoViewIfNeeded();
    await shot(page, `overview-${tag}-centers`);
    await shot(page, `overview-${tag}-full`, true);
}

const receipts = () =>
    JSON.parse(readFileSync(join(OUT, "receipts.json"), "utf8")) as {
        rollNo: string;
        checkInCode: string;
        receiptCode: string;
        right: number;
        wrong: number;
        blank: number;
    }[];

async function publish(page: Page) {
    step(
        "publish: the authority computes and publishes results in the browser",
    );
    await open(page, "/authority");
    await signIn(page, "Exam authority");
    const desk = page.locator("#publish");
    await desk.scrollIntoViewIfNeeded();
    const go = desk.getByRole("button", { name: /^Compute and/ });
    step("publish: waiting for the answers round to be on chain");
    await page.waitForFunction(
        () => {
            const b = [...document.querySelectorAll("#publish button")].find(
                (x) => /^Compute and/.test(x.textContent ?? ""),
            );
            return b instanceof HTMLButtonElement && !b.disabled;
        },
        null,
        { timeout: 600_000, polling: 1000 },
    );
    await go.click();
    const done = desk.locator(".panel-box[role=status]");
    await done.waitFor({ timeout: 180_000 });
    const title = await done.locator(".box-title").innerText();
    console.log(`    ${title}`);
    assert.match(title, new RegExp(`^${receipts().length} results published`));
    await shot(page, "08-authority-results-published");
}

async function results(page: Page) {
    const sat = receipts();
    const who = sat[0]!;
    step(`results: candidate ${who.rollNo} checks their result`);
    await open(page, "/results");
    await page.getByLabel("Roll number").fill(who.rollNo);
    await page.getByLabel("Check-in code").fill("WRONG1");
    await page.getByRole("button", { name: "Check my result" }).click();
    await page
        .getByText("No result matches this roll number and check-in code")
        .waitFor({ timeout: 30_000 });
    await shot(page, "09-results-wrong-code");

    await page.getByLabel("Check-in code").fill(who.checkInCode.toLowerCase());
    await page.getByRole("button", { name: "Check my result" }).click();
    await page.locator(".answers").waitFor({ timeout: 120_000 });
    const rows = page.locator(".proofs__row");
    assert.equal(
        await page.locator(".proofs__row.is-failed").count(),
        0,
        "no failed proof",
    );
    assert.equal(await rows.count(), 5);
    const receipt = (await page.locator(".receipt__code").innerText()).trim();
    assert.equal(
        receipt,
        who.receiptCode,
        "receipt code matches the one the terminal showed",
    );
    const score = Number(await page.locator(".score__value").innerText());
    assert.equal(score, who.right * 4 - who.wrong);
    assert.equal(await page.locator(".answer.is-done").count(), who.right);
    assert.equal(await page.locator(".answer.is-failed").count(), who.wrong);
    assert.equal(await page.locator(".answer.is-waiting").count(), who.blank);
    console.log(
        `    score ${score}, receipt ${receipt} matches the terminal's, 5 proofs pass`,
    );

    step("results: the questions show in the order the terminal showed them");
    const steady = sat[1]!;
    await page.getByLabel("Roll number").fill(steady.rollNo);
    await page.getByLabel("Check-in code").fill(steady.checkInCode);
    await page.getByRole("button", { name: "Check my result" }).click();
    await page.locator(".answers").waitFor({ timeout: 120_000 });
    await page.waitForFunction(
        (n) => document.querySelectorAll(".answer").length === n,
        steady.right + steady.wrong + steady.blank,
    );
    const shown = await page
        .locator(".answer")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-qid")));
    const exam = await readExam(
        createPublicClient({
            transport: http(deployment().rpcUrl),
        }) as PublicClient,
        deployment().registry,
    );
    const card = sat[1] as unknown as { shift: number; center: number };
    const log = (await (
        await fetch(
            `${deployment().gatewayUrls[card.center]}/api/log/${card.shift}/${candidateHash(exam.examId, steady.rollNo, steady.checkInCode)}`,
        )
    ).json()) as { qid: string }[];
    assert.deepEqual(
        shown,
        log.map((e) => e.qid),
        "results order equals the order the candidate answered in, which is the terminal's",
    );
    console.log(
        `    ${shown.length} questions in the terminal's order (checked against the gateway's answer log)`,
    );
    await shot(page, "10-results-verified");
    await shot(page, "10b-results-verified-full", true);
}

async function audit(page: Page) {
    step("audit: anyone runs every check in the browser");
    await open(page, "/audit");
    await page.getByRole("button", { name: "Run the audit" }).click();
    const summary = page.locator(".audit-summary");
    await summary.waitFor({ timeout: 300_000 });
    const text = await summary.innerText();
    console.log(`    ${text.replace(/\s+/g, " ")}`);
    for (const row of await page.locator(".audit-row").all())
        console.log(`      ${(await row.innerText()).split("\n")[0]}`);
    assert.match(text, /^All \d+ checks pass/);
    assert.equal(await page.locator(".audit-row.is-failed").count(), 0);
    await shot(page, "11-audit-all-pass", true);
}

async function create(page: Page) {
    step("create: the authority fills a new exam from the running one");
    await open(page, "/authority");
    const authority = await signIn(page, "Exam authority");
    const desk = page.locator("#create");
    await desk.getByLabel("Title").waitFor();
    await desk.scrollIntoViewIfNeeded();

    step("create: a threshold above the custodian count is refused inline");
    await desk.getByLabel("Custodians needed to open").fill("5");
    await desk
        .getByRole("button", { name: "Create the exam on chain" })
        .click();
    await desk
        .getByText("Threshold must be between 2 and the custodian count")
        .waitFor();
    assert.match(
        await desk.locator(".form__status").innerText(),
        /1 problem to fix/,
    );
    assert.equal(
        await desk
            .getByRole("button", { name: "Create the exam on chain" })
            .isDisabled(),
        true,
    );
    await desk
        .locator(".group", { hasText: "Custodians" })
        .scrollIntoViewIfNeeded();
    await shot(page, "12-create-exam-invalid");

    step("create: two wallet transactions deploy and freeze the new exam");
    await desk.getByLabel("Custodians needed to open").fill("2");
    await desk
        .getByLabel("Title")
        .fill("National Entrance Test, second sitting");
    await desk
        .getByText("The config passes every rule the contract checks")
        .waitFor();
    const before = await nonceOf(authority);
    await desk
        .getByRole("button", { name: "Create the exam on chain" })
        .click();
    const created = desk.locator(".created");
    await created.waitFor({ timeout: 60_000 });
    const registry = (await created
        .locator("[data-registry]")
        .getAttribute("data-registry")) as `0x${string}`;
    assert.equal(
        await nonceOf(authority),
        before + 2,
        "deploy and configure: two transactions",
    );
    const client = createPublicClient({
        transport: http(deployment().rpcUrl),
    }) as PublicClient;
    const fresh = await readExam(client, registry);
    assert.equal(fresh.config.title, "National Entrance Test, second sitting");
    assert.equal(fresh.authority.toLowerCase(), authority.toLowerCase());
    assert.equal(validateConfig(fresh.config).length, 0);
    const running = await readExam(client, deployment().registry);
    assert.equal(fresh.config.setters.length, running.config.setters.length);
    const drandNow = (
        (await (
            await fetch(`${deployment().drandUrl}/public/latest`)
        ).json()) as { round: number }
    ).round;
    assert.ok(
        fresh.config.sealRound > drandNow,
        `the new exam seals after the current drand round (${fresh.config.sealRound} > ${drandNow})`,
    );
    console.log(
        `    registry ${registry}, config hash ${fresh.configHash.slice(0, 14)}…, seal round ${fresh.config.sealRound}`,
    );
    await created.scrollIntoViewIfNeeded();
    await shot(page, "13-create-exam-done");
}

async function injectWallet(page: Page, account: string) {
    const rpcUrl = deployment().rpcUrl;
    await page.addInitScript(
        ({ rpcUrl, account }) => {
            let id = 0;
            let onExamChain = false;
            const calls: string[] = [];
            (window as unknown as { __walletCalls: string[] }).__walletCalls =
                calls;
            (window as unknown as { ethereum: unknown }).ethereum = {
                isMetaMask: true,
                on() {},
                removeListener() {},
                async request({
                    method,
                    params,
                }: {
                    method: string;
                    params?: unknown[];
                }) {
                    calls.push(method);
                    if (
                        method === "eth_requestAccounts" ||
                        method === "eth_accounts"
                    )
                        return [account];
                    if (method === "eth_chainId" && !onExamChain) return "0x1";
                    if (
                        method === "wallet_addEthereumChain" ||
                        method === "wallet_switchEthereumChain"
                    ) {
                        onExamChain = true;
                        return null;
                    }
                    const res = await fetch(rpcUrl, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            jsonrpc: "2.0",
                            id: ++id,
                            method,
                            params: params ?? [],
                        }),
                    });
                    const body = (await res.json()) as {
                        result?: unknown;
                        error?: {
                            code: number;
                            message: string;
                            data?: unknown;
                        };
                    };
                    if (body.error)
                        throw Object.assign(
                            new Error(body.error.message),
                            body.error,
                        );
                    return body.result;
                },
            };
        },
        { rpcUrl, account },
    );
}

async function revoke(page: Page) {
    const authority = (
        await readExam(
            createPublicClient({
                transport: http(deployment().rpcUrl),
            }) as PublicClient,
            deployment().registry,
        )
    ).authority;
    step("revoke: the authority signs in with an injected browser wallet");
    await injectWallet(page, authority);
    await open(page, "/authority");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Connect a wallet" }).click();
    await page
        .locator(".nav__identity", { hasText: "Exam authority" })
        .waitFor();
    const calls = await page.evaluate(
        () => (window as unknown as { __walletCalls: string[] }).__walletCalls,
    );
    assert.ok(
        calls.includes("eth_requestAccounts"),
        "the portal asked the wallet for its account",
    );
    assert.ok(
        calls.includes("wallet_addEthereumChain"),
        "the portal added the exam's chain to the wallet",
    );
    console.log(`    wallet calls: ${[...new Set(calls)].join(", ")}`);

    step("revoke: a center is revoked through the injected wallet");
    const before = await nonceOf(authority);
    const desk = page.locator("#centers");
    const target = desk.getByRole("button", { name: /^Revoke / }).last();
    const center = ((await target.textContent()) ?? "")
        .replace(/^Revoke /, "")
        .trim();
    await target.click();
    await desk
        .getByRole("button", { name: `Confirm: revoke ${center}` })
        .click();
    await desk
        .getByText("Center revoked in transaction")
        .waitFor({ timeout: 30_000 });
    assert.equal(await nonceOf(authority), before + 1);
    assert.ok(
        (
            await page.evaluate(
                () =>
                    (window as unknown as { __walletCalls: string[] })
                        .__walletCalls,
            )
        ).includes("eth_sendTransaction"),
    );
    await desk
        .locator(".state--failed", { hasText: "Revoked" })
        .first()
        .waitFor({ timeout: 10_000 });
    await desk.scrollIntoViewIfNeeded();
    await shot(page, "14-authority-revoked-injected-wallet");

    step("revoke: the revoked center has no revoke button left");
    assert.equal(
        await desk.getByRole("button", { name: `Revoke ${center}` }).count(),
        0,
    );
    console.log(`    revoked ${center}`);
    await open(page, "/");
    await page.locator("#centers").scrollIntoViewIfNeeded();
    await page
        .locator("#centers .state--failed", { hasText: "Revoked" })
        .first()
        .waitFor({ timeout: 10_000 });
    await shot(page, "15-overview-center-revoked");
}

const STAGES: Record<string, (page: Page) => Promise<void>> = {
    setter,
    authority,
    create,
    overview,
    publish,
    results,
    audit,
    revoke,
};

const names = process.argv.slice(2);
const browser = await launch();
let failed = false;
try {
    for (const name of names) {
        const stage = STAGES[name];
        if (!stage)
            throw new Error(
                `no stage ${name}; stages: ${Object.keys(STAGES).join(", ")}`,
            );
        const { page, problems } = await openPage(browser);
        try {
            await stage(page);
            const real = problems.filter(
                (p) => !/Failed to load resource/.test(p),
            );
            assert.equal(
                real.length,
                0,
                `console errors in ${name}:\n${real.join("\n")}`,
            );
            step(`${name}: passed`);
        } catch (e) {
            failed = true;
            await shot(page, `fail-${name}`, true).catch(() => undefined);
            console.error(
                `FAILED ${name}: ${e instanceof Error ? e.stack : e}`,
            );
            if (problems.length) console.error(problems.join("\n"));
            break;
        } finally {
            await page.context().close();
        }
    }
} finally {
    await browser.close();
}
process.exitCode = failed ? 1 : 0;
