import { chromium } from 'playwright-core';

/**
 * Drives the browser container of a replay Pod over CDP (RR_CDP=http://<ip>:9223), opens a page
 * and reports what an agent would see, plus the browser's clock. Used by deploy/local-pod-test.sh.
 */
async function main(): Promise<void> {
  const cdp = process.env.RR_CDP;
  if (!cdp) throw new Error('RR_CDP is not set');
  const url = process.argv[2] ?? 'https://www.amazon.com/dp/B0FQFB8FMG';
  const browser = await chromium.connectOverCDP(cdp, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);
  const report = {
    url,
    status: resp?.status(),
    title: (await page.locator('#productTitle').innerText().catch(() => '')).trim() || (await page.title()),
    price: (await page.locator('#corePrice_feature_div .a-offscreen').first().textContent().catch(() => ''))?.trim(),
    deliverTo: (await page.locator('#glow-ingress-line2').innerText().catch(() => '')).trim(),
    browserClock: await page.evaluate(() => new Date().toISOString()),
  };
  console.log(JSON.stringify(report, null, 2));
  await page.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
