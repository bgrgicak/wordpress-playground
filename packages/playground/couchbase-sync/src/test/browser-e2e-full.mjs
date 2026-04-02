/**
 * Full E2E test:
 * 1. Save site to Couchbase
 * 2. Create a post
 * 3. Verify CouchDB config fields appear in site settings
 * 4. Fill in CouchDB config fields
 * 5. Save settings
 * 6. Reload and verify post survives + config persists
 */
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5400/website-server/';
const TIMEOUT = 120_000;
let failures = 0;

function assert(condition, message) {
	if (!condition) {
		console.error(`  FAIL: ${message}`);
		failures++;
	} else {
		console.log(`  PASS: ${message}`);
	}
}

async function main() {
	const browser = await chromium.launch({ headless: true });
	const page = await (
		await browser.newContext({ viewport: { width: 1280, height: 900 } })
	).newPage();

	try {
		// === STEP 1: Boot & Save to Couchbase ===
		console.log('STEP 1: Boot Playground...');
		await page.goto(BASE_URL, { timeout: TIMEOUT, waitUntil: 'load' });
		await page.waitForTimeout(45_000);

		console.log('STEP 2: Save to Couchbase...');
		await page.locator('button:has-text("Save")').first().click();
		await page.waitForTimeout(1000);
		await page.getByText('Save to Couchbase').click();
		await page.waitForTimeout(500);
		await page.locator('[role="dialog"] button[type="submit"]').click();
		await page.waitForTimeout(10_000);

		const savedIndicator = await page
			.getByText('Saved Playground')
			.isVisible()
			.catch(() => false);
		assert(savedIndicator, 'Site shows as saved');

		// === STEP 3: Create a post ===
		const postTitle = `E2E_CouchDB_${Date.now()}`;
		console.log(`STEP 3: Creating post "${postTitle}"...`);
		const createResult = await page.evaluate(async (title) => {
			const client = window.playground;
			if (!client) return { error: 'no client' };
			const r = await client.run({
				code: `<?php
					require '/wordpress/wp-load.php';
					$id = wp_insert_post(['post_title' => '${title}', 'post_content' => 'CouchDB test.', 'post_status' => 'publish', 'post_author' => 1]);
					echo json_encode(['id' => $id]);
				`,
			});
			return JSON.parse(r.text);
		}, postTitle);
		assert(createResult.id > 0, `Post created with ID ${createResult.id}`);
		await page.waitForTimeout(5_000); // Wait for snapshot

		// === STEP 4: Open site settings and check CouchDB fields ===
		console.log('STEP 4: Opening site settings...');
		// Click the gear icon to open site manager
		const gearButton = page
			.locator('[aria-label="Edit Playground settings"]')
			.first();
		if (await gearButton.isVisible().catch(() => false)) {
			await gearButton.click();
			await page.waitForTimeout(1000);
		}
		// Click the Settings tab
		const settingsTab = page.getByRole('tab', { name: /settings/i });
		if (await settingsTab.isVisible().catch(() => false)) {
			await settingsTab.click();
			await page.waitForTimeout(1000);
		}
		await page.screenshot({ path: '/tmp/playground-e2e-settings.png' });

		// Check for CouchDB fields
		const couchdbHeader = page.getByText('Remote CouchDB Sync');
		const hasCouchDBSection = await couchdbHeader
			.isVisible()
			.catch(() => false);
		assert(
			hasCouchDBSection,
			'CouchDB config section is visible in settings'
		);

		if (hasCouchDBSection) {
			// Check individual fields exist
			const urlField = page.getByPlaceholder(
				'https://couchdb.example.com:5984'
			);
			const dbField = page.getByPlaceholder('my-wordpress-site');
			const userField = page.getByPlaceholder('admin');
			assert(
				await urlField.isVisible().catch(() => false),
				'Server URL field is visible'
			);
			assert(
				await dbField.isVisible().catch(() => false),
				'Database name field is visible'
			);
			assert(
				await userField.isVisible().catch(() => false),
				'Username field is visible'
			);

			// === STEP 5: Fill in CouchDB config ===
			console.log('STEP 5: Filling CouchDB config...');
			await urlField.fill('https://couch.example.com:5984');
			await dbField.fill('my-wp-playground');
			await userField.fill('playground-user');

			// Find and fill password field
			const pwField = page.locator('input[type="password"]').first();
			if (await pwField.isVisible().catch(() => false)) {
				await pwField.fill('secret123');
			}

			// Click Save & Reload
			const saveBtn = page.getByRole('button', { name: 'Save & Reload' });
			if (await saveBtn.isVisible().catch(() => false)) {
				console.log('STEP 6: Saving settings...');
				await saveBtn.click();
				await page.waitForTimeout(10_000);
			}
		}

		// === STEP 7: Reload and verify ===
		console.log('STEP 7: Reloading...');
		await page.reload({ timeout: TIMEOUT, waitUntil: 'load' });
		await page.waitForTimeout(45_000);

		// Check post survived
		const postCheck = await page.evaluate(async (title) => {
			const client = window.playground;
			if (!client) return { error: 'no client' };
			const r = await client.run({
				code: `<?php
					require '/wordpress/wp-load.php';
					$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
					$titles = array_map(function($p) { return $p->post_title; }, $posts);
					echo json_encode($titles);
				`,
			});
			return { titles: JSON.parse(r.text) };
		}, postTitle);

		assert(
			postCheck.titles?.includes(postTitle),
			`Post "${postTitle}" survived reload`
		);

		// Check CouchDB config persisted (open settings again)
		const gearButton2 = page
			.locator('[aria-label="Edit Playground settings"]')
			.first();
		if (await gearButton2.isVisible().catch(() => false)) {
			await gearButton2.click();
			await page.waitForTimeout(1000);
		}
		const settingsTab2 = page.getByRole('tab', { name: /settings/i });
		if (await settingsTab2.isVisible().catch(() => false)) {
			await settingsTab2.click();
			await page.waitForTimeout(1000);
		}

		const urlValue = await page
			.getByPlaceholder('https://couchdb.example.com:5984')
			.inputValue()
			.catch(() => '');
		const dbValue = await page
			.getByPlaceholder('my-wordpress-site')
			.inputValue()
			.catch(() => '');
		const userValue = await page
			.getByPlaceholder('admin')
			.inputValue()
			.catch(() => '');

		assert(
			urlValue === 'https://couch.example.com:5984',
			`CouchDB URL persisted: "${urlValue}"`
		);
		assert(
			dbValue === 'my-wp-playground',
			`CouchDB database persisted: "${dbValue}"`
		);
		assert(
			userValue === 'playground-user',
			`CouchDB username persisted: "${userValue}"`
		);

		await page.screenshot({ path: '/tmp/playground-e2e-final.png' });

		console.log(
			`\n=== E2E TEST COMPLETE: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURES'} ===`
		);
	} catch (error) {
		console.error('TEST ERROR:', error.message);
		await page
			.screenshot({ path: '/tmp/playground-e2e-error.png' })
			.catch(() => {});
		failures++;
	} finally {
		await browser.close();
		process.exit(failures > 0 ? 1 : 0);
	}
}

main();
