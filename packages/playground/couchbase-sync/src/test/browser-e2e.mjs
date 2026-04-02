/**
 * Browser E2E test for Couchbase save flow.
 * Prerequisites: dev server running on http://127.0.0.1:5400
 */
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5400/website-server/';
const TIMEOUT = 120_000;

async function main() {
	console.log('Launching browser...');
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
	});
	const page = await context.newPage();

	const consoleErrors = [];
	const consoleLogs = [];
	page.on('console', (msg) => {
		const text = msg.text();
		if (msg.type() === 'error') {
			consoleErrors.push(text);
		}
		if (
			text.includes('CouchbaseSync') ||
			text.includes('couchbase') ||
			text.includes('Couchbase')
		) {
			consoleLogs.push(`[${msg.type()}] ${text}`);
		}
	});
	page.on('pageerror', (err) => {
		consoleErrors.push(err.message);
	});

	try {
		// 1. Navigate to Playground
		console.log('1. Navigating to Playground...');
		await page.goto(BASE_URL, { timeout: TIMEOUT, waitUntil: 'load' });

		// 2. Wait for WordPress to load
		console.log('2. Waiting for WordPress to boot (60s)...');
		await page.waitForTimeout(60_000);
		await page.screenshot({ path: '/tmp/playground-01-loaded.png' });
		console.log('   Screenshot: /tmp/playground-01-loaded.png');

		// 3. Find clickable elements - let's see what's on the page
		console.log('3. Looking for save-related elements...');

		// Try different selectors for the save button
		const selectors = [
			'button:has-text("Save")',
			'[data-testid*="save"]',
			'.save-status-indicator button',
			'button:has-text("Unsaved")',
			'text=Unsaved Playground',
			'text=Save',
		];

		for (const sel of selectors) {
			const count = await page.locator(sel).count();
			if (count > 0) {
				const text = await page
					.locator(sel)
					.first()
					.textContent()
					.catch(() => '(no text)');
				console.log(
					`   Found: ${sel} (count: ${count}, text: "${text.trim()}")`
				);
			}
		}

		// Also dump all visible buttons
		const buttons = await page.locator('button').all();
		console.log(`   Total buttons on page: ${buttons.length}`);
		for (const btn of buttons.slice(0, 15)) {
			const text = await btn.textContent().catch(() => '');
			const visible = await btn.isVisible().catch(() => false);
			if (visible && text.trim()) {
				console.log(`   - Button: "${text.trim().substring(0, 60)}"`);
			}
		}

		// 4. Click the "Save" button (not the text label)
		let saveClicked = false;
		const saveBtn = page.locator('button:has-text("Save")').first();
		if (await saveBtn.isVisible().catch(() => false)) {
			console.log('4. Clicking Save button...');
			await saveBtn.click();
			saveClicked = true;
		}

		if (!saveClicked) {
			console.log('4. No save button found yet, dumping HTML...');
			const html = await page.content();
			// Save the HTML for inspection
			const fs = await import('fs');
			fs.writeFileSync('/tmp/playground-page.html', html);
			console.log('   Page HTML saved to /tmp/playground-page.html');
			process.exit(1);
		}

		await page.waitForTimeout(2000);
		await page.screenshot({ path: '/tmp/playground-02-save-modal.png' });
		console.log('   Screenshot: /tmp/playground-02-save-modal.png');

		// 5. Check for Couchbase radio option
		console.log('5. Looking for Couchbase option...');
		const couchbaseLabel = page.getByText('Save to Couchbase');
		if (await couchbaseLabel.isVisible().catch(() => false)) {
			console.log('   PASS: Couchbase option is visible');
		} else {
			// Dump modal contents
			const dialog = page.locator('[role="dialog"]');
			if (await dialog.isVisible().catch(() => false)) {
				const dialogText = await dialog.textContent();
				console.log('   Modal text:', dialogText.substring(0, 500));
			}
			console.error('   FAIL: Couchbase option not visible');
			process.exit(1);
		}

		// 6. Select Couchbase
		console.log('6. Selecting Couchbase option...');
		await couchbaseLabel.click();
		await page.waitForTimeout(500);

		// 7. Click the Save submit button
		console.log('7. Submitting save...');
		const dialog = page.locator('[role="dialog"]');
		const submitBtn = dialog.locator('button[type="submit"]');
		if (await submitBtn.isVisible().catch(() => false)) {
			await submitBtn.click();
		} else {
			// Try clicking last Save button in dialog
			const saveBtns = dialog.getByRole('button', { name: 'Save' });
			await saveBtns.last().click();
		}

		// 8. Wait and monitor
		console.log('8. Waiting for save to complete (15s)...');
		await page.waitForTimeout(15_000);
		await page.screenshot({ path: '/tmp/playground-03-after-save.png' });
		console.log('   Screenshot: /tmp/playground-03-after-save.png');

		// Check for couchbase errors
		const cbErrors = consoleErrors.filter((e) =>
			e.toLowerCase().includes('couchbase')
		);
		if (cbErrors.length) {
			console.error('   Couchbase errors in console:');
			cbErrors.forEach((e) => console.error('   ', e));
		}

		// Print all couchbase-related console output
		if (consoleLogs.length) {
			console.log('   Couchbase console messages:');
			consoleLogs.forEach((m) => console.log('   ', m));
		}

		// Check if modal closed
		const modalGone = !(await page
			.locator('[role="dialog"]')
			.isVisible()
			.catch(() => false));
		console.log(`   Modal closed: ${modalGone}`);

		// 9. Test persistence - reload
		console.log('9. Reloading page to test persistence...');
		await page.reload({ timeout: TIMEOUT, waitUntil: 'load' });
		await page.waitForTimeout(45_000);
		await page.screenshot({ path: '/tmp/playground-04-after-reload.png' });
		console.log('   Screenshot: /tmp/playground-04-after-reload.png');

		// Check for restore messages
		const restoreLogs = consoleLogs.filter((m) => m.includes('Restored'));
		if (restoreLogs.length) {
			console.log('   Restore messages:', restoreLogs);
		}

		// Check if site loaded
		const allErrors = consoleErrors.filter(
			(e) =>
				e.toLowerCase().includes('couchbase') ||
				e.toLowerCase().includes('fatal')
		);
		if (allErrors.length) {
			console.error('   Errors after reload:');
			allErrors.forEach((e) => console.error('   ', e.substring(0, 200)));
		}

		console.log('\n=== BROWSER E2E TEST COMPLETE ===');
		console.log(`Total console errors: ${consoleErrors.length}`);
		console.log(`Couchbase-related logs: ${consoleLogs.length}`);
	} catch (error) {
		console.error('TEST ERROR:', error.message);
		await page
			.screenshot({ path: '/tmp/playground-test-error.png' })
			.catch(() => {});
		process.exit(1);
	} finally {
		await browser.close();
	}
}

main();
