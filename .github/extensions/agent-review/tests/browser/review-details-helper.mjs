export async function openChangeDetails(page) {
    if (await page.locator("body").evaluate((body) => body.classList.contains("reviewing"))) {
        await page.locator("#workflow-overview").click();
    }
    const details = page.locator("#review-background");
    await details.waitFor();
    await details.evaluate((element) => { element.open = true; });
}

export async function openReviewTool(page, tool) {
    const menu = page.locator(".workspace-explore").filter({ has: page.locator("#explore-architecture") });
    await menu.waitFor();
    await menu.evaluate((element) => { element.open = true; });
    await page.locator(`#explore-${tool}`).click();
}
