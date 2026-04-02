import { chromium } from 'playwright';
const BASE_URL = 'http://127.0.0.1:5400/website-server/';
async function main() {
	const browser = await chromium.launch({ headless: true });
	const page = await (
		await browser.newContext({ viewport: { width: 1280, height: 900 } })
	).newPage();
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push('PAGE ERROR: ' + err.message));
	await page.goto(BASE_URL, { timeout: 120000, waitUntil: 'load' });
	await page.waitForTimeout(45000);
	// Click Save
	await page.locator('button:has-text("Save")').first().click();
	await page.waitForTimeout(1000);
	// Select Couchbase
	await page.getByText('Save to Couchbase').click();
	await page.waitForTimeout(500);
	// Submit
	await page.locator('[role="dialog"] button[type="submit"]').click();
	await page.waitForTimeout(10000);
	console.log('=== ALL CONSOLE ERRORS ===');
	errors.forEach((e, i) => console.log(`${i + 1}. ${e.substring(0, 200)}`));
	console.log(`\nTotal: ${errors.length}`);
	const couchbaseErrors = errors.filter((e) =>
		e.toLowerCase().includes('couchbase')
	);
	if (couchbaseErrors.length) {
		console.log('\nCOUCHBASE ERRORS:');
		couchbaseErrors.forEach((e) => console.log('  ', e));
	} else {
		console.log('\nNo Couchbase-related errors.');
	}
	await browser.close();
}
main();
