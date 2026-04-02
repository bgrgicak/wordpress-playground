/**
 * Measures performance of the Couchbase sync:
 * - SQLite file size
 * - Time to snapshot to IndexedDB
 * - Time to restore from IndexedDB
 * - Impact on request latency
 */
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5400/website-server/';

async function main() {
	const browser = await chromium.launch({ headless: true });
	const page = await (
		await browser.newContext({ viewport: { width: 1280, height: 900 } })
	).newPage();

	console.log('Booting Playground...');
	await page.goto(BASE_URL, { timeout: 120000, waitUntil: 'load' });
	await page.waitForTimeout(45000);

	// Save to Couchbase
	await page.locator('button:has-text("Save")').first().click();
	await page.waitForTimeout(1000);
	await page.getByText('Save to Couchbase').click();
	await page.waitForTimeout(500);
	await page.locator('[role="dialog"] button[type="submit"]').click();
	await page.waitForTimeout(10000);
	console.log('Saved. Now measuring...\n');

	// Measure SQLite file size
	const fileSize = await page.evaluate(async () => {
		const client = window.playground;
		const result = await client.run({
			code: `<?php echo filesize('/wordpress/wp-content/database/.ht.sqlite');`,
		});
		return parseInt(result.text);
	});
	console.log(`SQLite file size: ${(fileSize / 1024).toFixed(1)} KB`);

	// Measure IndexedDB snapshot size
	const idbSize = await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		const cbDb = dbs.find((d) => d.name?.includes('couchbase-sqlite-sync'));
		if (!cbDb) return null;
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open(cbDb.name);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const tx = db.transaction('sqlite-snapshots', 'readonly');
		const data = await new Promise((resolve, reject) => {
			const req = tx.objectStore('sqlite-snapshots').get('latest');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		db.close();
		return data ? data.byteLength : 0;
	});
	console.log(`IndexedDB snapshot size: ${(idbSize / 1024).toFixed(1)} KB`);

	// Measure time to do a PHP request WITHOUT sync overhead
	// (We can't easily disable sync, so we'll measure request time)
	console.log('\n--- Request latency with sync ---');
	const requestTimes = await page.evaluate(async () => {
		const client = window.playground;
		const times = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			await client.run({
				code: `<?php require '/wordpress/wp-load.php'; echo 'ok';`,
			});
			times.push(performance.now() - start);
		}
		return times;
	});
	const avgRequest =
		requestTimes.reduce((a, b) => a + b, 0) / requestTimes.length;
	console.log(
		`Request times: ${requestTimes.map((t) => t.toFixed(0) + 'ms').join(', ')}`
	);
	console.log(`Average: ${avgRequest.toFixed(0)}ms`);

	// Measure snapshot write time directly
	console.log('\n--- Snapshot write time ---');
	const snapshotTimes = await page.evaluate(async () => {
		const client = window.playground;
		const times = [];
		const DB_PATH = '/wordpress/wp-content/database/.ht.sqlite';

		for (let i = 0; i < 5; i++) {
			// Read the file
			const start1 = performance.now();
			const data = await client.readFileAsBuffer(DB_PATH);
			const readTime = performance.now() - start1;

			// Write to IndexedDB
			const start2 = performance.now();
			const dbName = 'perf-test-db';
			const db = await new Promise((resolve, reject) => {
				const req = indexedDB.open(dbName, 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore('store');
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise((resolve, reject) => {
				const tx = db.transaction('store', 'readwrite');
				tx.objectStore('store').put(data.buffer, 'key');
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
			const writeTime = performance.now() - start2;

			times.push({
				readTime,
				writeTime,
				totalTime: readTime + writeTime,
				size: data.byteLength,
			});
		}
		// Cleanup
		indexedDB.deleteDatabase('perf-test-db');
		return times;
	});

	for (const t of snapshotTimes) {
		console.log(
			`  Read: ${t.readTime.toFixed(1)}ms, IDB write: ${t.writeTime.toFixed(1)}ms, Total: ${t.totalTime.toFixed(1)}ms (${(t.size / 1024).toFixed(0)}KB)`
		);
	}
	const avgSnapshot =
		snapshotTimes.reduce((a, b) => a + b.totalTime, 0) /
		snapshotTimes.length;
	console.log(`  Average snapshot: ${avgSnapshot.toFixed(1)}ms`);

	// Now add some data and measure again
	console.log('\n--- After adding 50 posts ---');
	await page.evaluate(async () => {
		const client = window.playground;
		await client.run({
			code: `<?php
				require '/wordpress/wp-load.php';
				for ($i = 0; $i < 50; $i++) {
					wp_insert_post([
						'post_title' => 'Bulk post ' . $i,
						'post_content' => str_repeat('Lorem ipsum dolor sit amet. ', 50),
						'post_status' => 'publish',
						'post_author' => 1,
					]);
				}
			`,
		});
	});

	const newFileSize = await page.evaluate(async () => {
		const client = window.playground;
		const result = await client.run({
			code: `<?php echo filesize('/wordpress/wp-content/database/.ht.sqlite');`,
		});
		return parseInt(result.text);
	});
	console.log(
		`SQLite file size after 50 posts: ${(newFileSize / 1024).toFixed(1)} KB (was ${(fileSize / 1024).toFixed(1)} KB)`
	);

	const snapshotTimes2 = await page.evaluate(async () => {
		const client = window.playground;
		const times = [];
		const DB_PATH = '/wordpress/wp-content/database/.ht.sqlite';
		for (let i = 0; i < 3; i++) {
			const start1 = performance.now();
			const data = await client.readFileAsBuffer(DB_PATH);
			const readTime = performance.now() - start1;
			const start2 = performance.now();
			const db = await new Promise((resolve, reject) => {
				const req = indexedDB.open('perf-test-db2', 1);
				req.onupgradeneeded = () => {
					req.result.createObjectStore('store');
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			await new Promise((resolve, reject) => {
				const tx = db.transaction('store', 'readwrite');
				tx.objectStore('store').put(data.buffer, 'key');
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
			const writeTime = performance.now() - start2;
			times.push({
				readTime,
				writeTime,
				totalTime: readTime + writeTime,
				size: data.byteLength,
			});
		}
		indexedDB.deleteDatabase('perf-test-db2');
		return times;
	});

	for (const t of snapshotTimes2) {
		console.log(
			`  Read: ${t.readTime.toFixed(1)}ms, IDB write: ${t.writeTime.toFixed(1)}ms, Total: ${t.totalTime.toFixed(1)}ms (${(t.size / 1024).toFixed(0)}KB)`
		);
	}

	console.log('\n=== DONE ===');
	await browser.close();
}

main();
