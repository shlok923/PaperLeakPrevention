import { launch, openPage, portalUrl, shot } from "./browser.ts";

const [path = "/", name = "page", w = "1440", h = "900"] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"));
const full = process.argv.includes("--full");
const browser = await launch();
try {
    const { page, problems } = await openPage(browser, Number(w), Number(h));
    await page.goto(portalUrl(path), { waitUntil: "networkidle" });
    await page.waitForSelector("main#top:not(.boot)", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await shot(page, name, full);
    if (problems.length) console.log(problems.join("\n"));
} finally {
    await browser.close();
}
