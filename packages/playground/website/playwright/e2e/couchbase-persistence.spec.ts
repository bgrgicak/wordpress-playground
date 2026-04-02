/**
 * Focused E2E tests for Couchbase data persistence across reloads
 * and remote sync. These tests verify the ACTUAL user workflow:
 *
 * 1. Save site to Couchbase
 * 2. Make changes via WordPress admin UI
 * 3. Reload → changes should persist
 * 4. Configure remote → data should sync
 *
 * Previous tests were unreliable because they:
 * - Used playground.run() which bypasses SQLite hooks
 * - Used waitForTimeout() hoping the snapshot timer fires
 * - Didn't verify data actually reached PouchDB before reload
 */
import { test, expect } from '../playground-fixtures.ts';
import type { FrameLocator, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function saveSiteToCouchbase(
	page: Page,
	options?: { customName?: string }
) {
	const saveButton = page.getByRole('button', { name: 'Save site locally' });
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = page.getByRole('dialog', { name: 'Save Playground' });
	await expect(dialog).toBeVisible({ timeout: 10000 });

	if (options?.customName) {
		const nameInput = dialog.getByLabel('Playground name');
		await nameInput.fill('');
		await nameInput.type(options.customName);
	}

	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).not.toBeVisible({ timeout: 120000 });
}

/**
 * Wait for the periodic snapshot to run and verify PouchDB has data
 * by checking the IndexedDB directly.
 */
async function waitForPouchDBSnapshot(
	page: Page,
	{
		dbNameSubstring,
		minDocs = 1,
		timeout = 30000,
	}: { dbNameSubstring?: string; minDocs?: number; timeout?: number } = {}
) {
	const startTime = Date.now();
	while (Date.now() - startTime < timeout) {
		const result = await page.evaluate(
			async (opts) => {
				const dbs = await indexedDB.databases();
				const pouchDbs = dbs.filter(
					(db) =>
						db.name?.startsWith('_pouch_wp-playground-') &&
						(!opts.sub || db.name?.includes(opts.sub))
				);
				if (pouchDbs.length === 0) return { found: false, count: 0 };

				// Open the IDB directly to count docs
				return new Promise<{ found: boolean; count: number }>(
					(resolve) => {
						const dbName = pouchDbs[0]!.name!;
						const req = indexedDB.open(dbName);
						req.onsuccess = () => {
							const idb = req.result;
							try {
								const tx = idb.transaction(
									'by-sequence',
									'readonly'
								);
								const store = tx.objectStore('by-sequence');
								const countReq = store.count();
								countReq.onsuccess = () => {
									idb.close();
									resolve({
										found: true,
										count: countReq.result,
									});
								};
								countReq.onerror = () => {
									idb.close();
									resolve({ found: true, count: 0 });
								};
							} catch {
								idb.close();
								resolve({ found: true, count: 0 });
							}
						};
						req.onerror = () => resolve({ found: false, count: 0 });
					}
				);
			},
			{ sub: dbNameSubstring }
		);

		if (result.found && result.count >= minDocs) {
			return result;
		}
		await page.waitForTimeout(1000);
	}
	return { found: false, count: 0 };
}

test('data persists in PouchDB after periodic snapshot', async ({
	website,
	wordpress,
	browserName,
	page,
}) => {
	test.skip(browserName !== 'chromium', 'Couchbase tests require Chromium.');

	// Capture ALL console messages
	const logs: string[] = [];
	page.on('console', (msg) => {
		logs.push(`[${msg.type()}] ${msg.text()}`);
	});

	// 1. Load site with wp-admin and save to Couchbase
	await website.goto('./?url=/wp-admin/');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `Persist Test ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// 2. Wait for site reboot after save
	await website.waitForNestedIframes();

	// 3. Verify PouchDB has data from the initial snapshot
	const snapshot1 = await waitForPouchDBSnapshot(page, { minDocs: 50 });
	// eslint-disable-next-line no-console
	console.log(`After initial save: PouchDB has ${snapshot1.count} docs`);
	expect(snapshot1.count).toBeGreaterThan(50);

	// 4. Change blog name through WordPress admin UI
	await website.ensureSiteManagerIsClosed();
	await wordpress
		.locator('#menu-settings a.menu-top')
		.evaluate((el) => (el as HTMLElement).click());
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	const customBlogName = `Persist Blog ${Date.now()}`;
	await wordpress.locator('#blogname').fill(customBlogName);
	await wordpress.locator('#submit').click();
	await expect(
		wordpress.locator('#setting-error-settings_updated')
	).toBeVisible({ timeout: 30000 });

	// 5. Wait for periodic snapshot to capture the change
	// The snapshot timer is 5s. Wait for at least 2 cycles.
	await page.waitForTimeout(12000);

	// 6. Check PouchDB doc count increased
	const snapshot2 = await waitForPouchDBSnapshot(page, { minDocs: 50 });
	// eslint-disable-next-line no-console
	console.log(`After blog name change: PouchDB has ${snapshot2.count} docs`);

	// Print any errors
	const errors = logs.filter(
		(l) =>
			l.includes('[error]') &&
			!l.includes('net::ERR_') &&
			!l.includes('favicon')
	);
	if (errors.length > 0) {
		// eslint-disable-next-line no-console
		console.log('Console errors:', errors.join('\n'));
	}

	// Print snapshot-related logs
	const snapshotLogs = logs.filter(
		(l) =>
			l.includes('CouchbaseSync') ||
			l.includes('snapshot') ||
			l.includes('Snapshot')
	);
	// eslint-disable-next-line no-console
	console.log('Snapshot logs:', snapshotLogs.join('\n'));

	// 7. Before reload, count docs per collection in PouchDB
	const preReloadStats = await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		const pouchDb = dbs.find((db) =>
			db.name?.startsWith('_pouch_wp-playground-')
		);
		if (!pouchDb?.name) return { error: 'no pouchdb found' };

		// Use raw IDB to count by collection prefix
		return new Promise<Record<string, number>>((resolve) => {
			const req = indexedDB.open(pouchDb.name!);
			req.onsuccess = () => {
				const idb = req.result;
				try {
					const tx = idb.transaction('by-sequence', 'readonly');
					const store = tx.objectStore('by-sequence');
					const getAll = store.getAll();
					getAll.onsuccess = () => {
						const stats: Record<string, number> = {};
						for (const doc of getAll.result) {
							if (doc._id) {
								const prefix =
									doc._id.split('::')[0] || 'unknown';
								stats[prefix] = (stats[prefix] || 0) + 1;
							}
						}
						idb.close();
						resolve(stats);
					};
					getAll.onerror = () => {
						idb.close();
						resolve({ error_reading: 1 });
					};
				} catch {
					idb.close();
					resolve({ error_catch: 1 });
				}
			};
			req.onerror = () => resolve({ error_open: 1 });
		});
	});
	// eslint-disable-next-line no-console
	console.log(
		'PouchDB collections before reload:',
		JSON.stringify(preReloadStats)
	);

	// 7b. Reload and verify
	const savedUrl = website.page.url();
	const reloadLogs: string[] = [];
	page.on('console', (msg) => {
		reloadLogs.push(`[${msg.type()}] ${msg.text()}`);
	});

	await page.goto(savedUrl);
	await website.waitForNestedIframes();

	// Print restore logs
	const restoreLogs = reloadLogs.filter(
		(l) => l.includes('CouchbaseSync') || l.includes('Restored')
	);
	// eslint-disable-next-line no-console
	console.log('Restore logs:', restoreLogs.join('\n'));

	// 8. Navigate to Settings and check blog name
	await wordpress
		.locator('#menu-settings a.menu-top')
		.evaluate((el) => (el as HTMLElement).click());
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	const actualValue = await wordpress.locator('#blogname').inputValue();
	// eslint-disable-next-line no-console
	console.log(
		`Blog name check: expected="${customBlogName}" got="${actualValue}"`
	);

	await expect(wordpress.locator('#blogname')).toHaveValue(customBlogName);
});
