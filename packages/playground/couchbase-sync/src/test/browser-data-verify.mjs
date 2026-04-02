/**
 * Verifies actual data flow:
 * 1. Boot WordPress, save to Couchbase
 * 2. Create a post in WordPress
 * 3. Check IndexedDB for the Couchbase data
 * 4. Reload the page
 * 5. Verify the post survived the reload
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

	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});

	try {
		// ===== STEP 1: Boot and save to Couchbase =====
		console.log('STEP 1: Boot Playground and save to Couchbase...');
		await page.goto(BASE_URL, { timeout: TIMEOUT, waitUntil: 'load' });
		await page.waitForTimeout(45_000);

		// Click Save button
		await page.locator('button:has-text("Save")').first().click();
		await page.waitForTimeout(1000);
		// Select Couchbase
		await page.getByText('Save to Couchbase').click();
		await page.waitForTimeout(500);
		// Submit
		await page.locator('[role="dialog"] button[type="submit"]').click();
		await page.waitForTimeout(10_000);
		console.log('   Saved to Couchbase.');

		// ===== STEP 2: Create a uniquely-named post =====
		const postTitle = `CouchbaseTestPost_${Date.now()}`;
		console.log(
			`STEP 2: Creating post "${postTitle}" via WP-CLI equivalent...`
		);

		// Navigate to the WP iframe and create a post via PHP
		// Use the Playground's JavaScript API to run PHP
		const postCreated = await page.evaluate(async (title) => {
			try {
				const client = window.playground;
				if (!client)
					return { error: 'window.playground not available' };
				const result = await client.run({
					code: `<?php
						require '/wordpress/wp-load.php';
						$id = wp_insert_post([
							'post_title'   => '${title}',
							'post_content' => 'This post should survive a reload.',
							'post_status'  => 'publish',
							'post_author'  => 1,
						]);
						echo json_encode(['post_id' => $id, 'title' => '${title}']);
					`,
				});
				return { text: result.text, errors: result.errors };
			} catch (e) {
				return { error: e.message };
			}
		}, postTitle);
		console.log('   Post creation result:', JSON.stringify(postCreated));

		if (postCreated.error) {
			console.error('FAIL: Could not create post:', postCreated.error);
			process.exit(1);
		}

		// Wait for the sync to flush (outbound interval is 3s)
		console.log('   Waiting 5s for Couchbase sync to flush...');
		await page.waitForTimeout(5_000);

		// ===== STEP 3: Check IndexedDB for Couchbase data =====
		console.log('STEP 3: Checking IndexedDB for Couchbase Lite data...');
		const idbData = await page.evaluate(async () => {
			// List all IndexedDB databases
			const databases = await indexedDB.databases();
			const dbNames = databases.map((d) => d.name);

			// Find Couchbase-related databases
			const cbDbs = dbNames.filter(
				(n) =>
					n &&
					(n.includes('wp-playground') ||
						n.includes('couchbase') ||
						n.includes('Couchbase'))
			);

			// Try to read from each CB database
			const results = {};
			for (const dbName of cbDbs) {
				try {
					const db = await new Promise((resolve, reject) => {
						const req = indexedDB.open(dbName);
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					const storeNames = Array.from(db.objectStoreNames);
					results[dbName] = {
						storeNames,
						storeCount: storeNames.length,
					};

					// Count records in each store
					for (const storeName of storeNames.slice(0, 10)) {
						try {
							const tx = db.transaction(storeName, 'readonly');
							const store = tx.objectStore(storeName);
							const count = await new Promise(
								(resolve, reject) => {
									const req = store.count();
									req.onsuccess = () => resolve(req.result);
									req.onerror = () => reject(req.error);
								}
							);
							results[dbName][storeName] = { recordCount: count };
						} catch (e) {
							results[dbName][storeName] = { error: e.message };
						}
					}
					db.close();
				} catch (e) {
					results[dbName] = { error: e.message };
				}
			}

			return { allDbs: dbNames, couchbaseDbs: cbDbs, data: results };
		});

		console.log('   All IndexedDB databases:', idbData.allDbs);
		console.log('   Couchbase databases:', idbData.couchbaseDbs);
		if (Object.keys(idbData.data).length > 0) {
			console.log('   Couchbase DB contents:');
			for (const [dbName, info] of Object.entries(idbData.data)) {
				console.log(`     ${dbName}:`);
				if (info.error) {
					console.log(`       Error: ${info.error}`);
				} else {
					console.log(
						`       Stores: ${info.storeNames?.join(', ')}`
					);
					for (const [store, data] of Object.entries(info)) {
						if (
							store !== 'storeNames' &&
							store !== 'storeCount' &&
							data.recordCount !== undefined
						) {
							console.log(
								`       ${store}: ${data.recordCount} records`
							);
						}
					}
				}
			}
		} else {
			console.error(
				'   FAIL: No Couchbase databases found in IndexedDB!'
			);
			console.log('   This means data is NOT being saved to Couchbase.');
			await page.screenshot({
				path: '/tmp/playground-data-verify-fail.png',
			});
			process.exit(1);
		}

		// ===== STEP 4: Verify post exists before reload =====
		console.log('STEP 4: Verifying post exists before reload...');
		const preReloadCheck = await page.evaluate(async (title) => {
			try {
				const client = window.playground;
				if (!client) return { error: 'no playground client' };
				const result = await client.run({
					code: `<?php
						require '/wordpress/wp-load.php';
						$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
						$titles = array_map(function($p) { return $p->post_title; }, $posts);
						echo json_encode($titles);
					`,
				});
				return { titles: JSON.parse(result.text) };
			} catch (e) {
				return { error: e.message };
			}
		}, postTitle);
		console.log('   Posts before reload:', JSON.stringify(preReloadCheck));

		const hasPostBeforeReload = preReloadCheck.titles?.includes(postTitle);
		console.log(`   Post "${postTitle}" found: ${hasPostBeforeReload}`);
		if (!hasPostBeforeReload) {
			console.error('   FAIL: Post was not even created properly.');
			process.exit(1);
		}

		// ===== STEP 5: Reload and check if post survived =====
		console.log('STEP 5: Reloading page...');
		await page.reload({ timeout: TIMEOUT, waitUntil: 'load' });
		console.log('   Waiting for WordPress to reboot (45s)...');
		await page.waitForTimeout(45_000);

		console.log('STEP 6: Checking if post survived reload...');
		const postReloadCheck = await page.evaluate(async (title) => {
			try {
				const client = window.playground;
				if (!client) return { error: 'no playground client' };
				const result = await client.run({
					code: `<?php
						require '/wordpress/wp-load.php';
						$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
						$titles = array_map(function($p) { return $p->post_title; }, $posts);
						echo json_encode($titles);
					`,
				});
				return { titles: JSON.parse(result.text) };
			} catch (e) {
				return { error: e.message };
			}
		}, postTitle);
		console.log('   Posts after reload:', JSON.stringify(postReloadCheck));

		const hasPostAfterReload = postReloadCheck.titles?.includes(postTitle);
		if (hasPostAfterReload) {
			console.log(`\n   PASS: Post "${postTitle}" survived the reload!`);
			console.log(
				'   Data is correctly persisted in Couchbase and restored to SQLite.'
			);
		} else {
			console.error(
				`\n   FAIL: Post "${postTitle}" did NOT survive the reload.`
			);
			console.error(
				'   Data is NOT being restored from Couchbase to SQLite.'
			);
			await page.screenshot({
				path: '/tmp/playground-data-no-persist.png',
			});
			process.exit(1);
		}

		// Print any couchbase errors
		const cbErrors = errors.filter((e) =>
			e.toLowerCase().includes('couchbase')
		);
		if (cbErrors.length) {
			console.log('\nCouchbase console errors:');
			cbErrors.forEach((e) => console.log('  ', e));
		}

		console.log('\n=== DATA VERIFICATION COMPLETE ===');
	} catch (error) {
		console.error('TEST ERROR:', error.message);
		await page
			.screenshot({ path: '/tmp/playground-data-error.png' })
			.catch(() => {});
		process.exit(1);
	} finally {
		await browser.close();
	}
}

main();
