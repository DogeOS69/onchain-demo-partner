import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.WEB_URL || 'http://127.0.0.1:5190';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('test/results', { recursive: true });
for (const route of ['/', '/external','/onchain','/randomness','/sponsorship']) {
  const response = await page.goto(`${base}${route}`); assert.equal(response.status(), 200);
  await page.locator('main').waitFor();
  await page.waitForTimeout(1000);
  assert(await page.locator('main').innerText());
}
await page.screenshot({ path: 'test/results/desktop.png', fullPage: true });
await page.setViewportSize({ width: 360, height: 800 });
assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.screenshot({ path: 'test/results/mobile.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/results/sdk-modal.png', fullPage: true });
console.log((await page.locator('body').innerText()).slice(-6500));
await writeFile('test/results/browser.json', JSON.stringify({ errors, routes: 5, mobileWidth: 360 }, null, 2));
await browser.close();
assert.equal(errors.length, 0, errors.join('\n'));
