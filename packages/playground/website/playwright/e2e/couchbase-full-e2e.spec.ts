/**
 * Comprehensive E2E tests for the Couchbase sync feature.
 *
 * Tests the full user workflow including:
 * - Local persistence after page reload
 * - Remote sync to a PouchDB server
 * - Multi-tab sync via remote server
 * - Plugin/theme persistence
 * - File persistence
 */
import { test, expect } from '../playground-fixtures.ts';
import type { FrameLocator, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const POUCHDB_PORT = 15984;
const POUCHDB_URL = `http://127.0.0.1:${POUCHDB_PORT}`;
const TEST_DB_NAME = `e2e-full-${Date.now()}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PouchDB: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pouchServer: any;

test.beforeAll(async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const pouchdb = require('pouchdb');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	pouchdb.plugin(require('pouchdb-adapter-memory'));
	PouchDB = pouchdb;

	// Start pouchdb-server (a standalone CouchDB-compatible server)
	// express-pouchdb's _changes route is broken with newer Express
	const { execSync, spawn } = require('child_process');
	const serverProcess = spawn(
		'npx',
		[
			'pouchdb-server',
			'--port',
			String(POUCHDB_PORT),
			'--in-memory',
			'--host',
			'127.0.0.1',
		],
		{ stdio: 'pipe' }
	);
	pouchServer = serverProcess;

	// Wait for server to be ready
	const startTime = Date.now();
	while (Date.now() - startTime < 15000) {
		try {
			execSync(`curl -s http://127.0.0.1:${POUCHDB_PORT}/`, {
				timeout: 2000,
			});
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
});

test.afterAll(async () => {
	if (pouchServer) {
		pouchServer.kill();
	}
});

// ── Helpers ──────────────────────────────────────────────

async function saveSiteToCouchbase(page: Page, customName: string) {
	const saveButton = page.getByRole('button', { name: 'Save site locally' });
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = page.getByRole('dialog', { name: 'Save Playground' });
	await expect(dialog).toBeVisible({ timeout: 10000 });

	const nameInput = dialog.getByLabel('Playground name');
	await nameInput.fill('');
	await nameInput.type(customName);

	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).not.toBeVisible({ timeout: 120000 });
}

/**
 * Count documents in PouchDB via IndexedDB.
 */
async function getPouchDBDocCount(page: Page): Promise<number> {
	return await page.evaluate(async () => {
		const dbs = await indexedDB.databases();
		const pouchDb = dbs.find((db) =>
			db.name?.startsWith('_pouch_wp-playground-')
		);
		if (!pouchDb?.name) return 0;
		return new Promise<number>((resolve) => {
			const req = indexedDB.open(pouchDb.name!);
			req.onsuccess = () => {
				const idb = req.result;
				try {
					const tx = idb.transaction('by-sequence', 'readonly');
					const countReq = tx.objectStore('by-sequence').count();
					countReq.onsuccess = () => {
						idb.close();
						resolve(countReq.result);
					};
					countReq.onerror = () => {
						idb.close();
						resolve(0);
					};
				} catch {
					idb.close();
					resolve(0);
				}
			};
			req.onerror = () => resolve(0);
		});
	});
}

/**
 * Wait for PouchDB to have at least N docs.
 */
async function waitForPouchDBDocs(
	page: Page,
	minDocs: number,
	timeout = 30000
) {
	const start = Date.now();
	let count = 0;
	while (Date.now() - start < timeout) {
		count = await getPouchDBDocCount(page);
		if (count >= minDocs) return count;
		await page.waitForTimeout(1000);
	}
	return count;
}

/**
 * Get remote PouchDB doc count.
 */
async function getRemoteDocCount(dbName: string): Promise<number> {
	const db = new PouchDB(`${POUCHDB_URL}/${dbName}`);
	try {
		const info = await db.info();
		return info.doc_count;
	} finally {
		await db.close();
	}
}

/**
 * Get a specific option from the remote database.
 */
async function getRemoteOption(
	dbName: string,
	optionName: string
): Promise<string | null> {
	const db = new PouchDB(`${POUCHDB_URL}/${dbName}`);
	try {
		const allDocs = await db.allDocs({
			startkey: 'wp_options::',
			endkey: 'wp_options::\ufff0',
			include_docs: true,
		});
		const match = allDocs.rows.find(
			(r: any) => r.doc?.option_name === optionName
		);
		return match?.doc?.option_value ?? null;
	} finally {
		await db.close();
	}
}

// ── Tests ────────────────────────────────────────────────

test.describe('Local persistence', () => {
	test('blog name persists after save → change → reload', async ({
		website,
		wordpress,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		await website.goto('./?url=/wp-admin/');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `Local Persist ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		// Wait for reboot
		await website.waitForNestedIframes();

		// Verify PouchDB has data
		const docCount = await waitForPouchDBDocs(page, 50);
		expect(docCount).toBeGreaterThan(50);

		// Change blog name via WP admin
		await website.ensureSiteManagerIsClosed();
		await wordpress
			.locator('#menu-settings a.menu-top')
			.evaluate((el) => (el as HTMLElement).click());
		await expect(wordpress.locator('#blogname')).toBeVisible({
			timeout: 60000,
		});

		const blogName = `Persistent ${Date.now()}`;
		await wordpress.locator('#blogname').fill(blogName);
		await wordpress.locator('#submit').click();
		await expect(
			wordpress.locator('#setting-error-settings_updated')
		).toBeVisible({ timeout: 30000 });

		// Wait for periodic snapshot (5s timer + margin)
		await page.waitForTimeout(12000);

		// Reload
		const url = website.page.url();
		await page.goto(url);
		await website.waitForNestedIframes();

		// Verify
		await wordpress
			.locator('#menu-settings a.menu-top')
			.evaluate((el) => (el as HTMLElement).click());
		await expect(wordpress.locator('#blogname')).toBeVisible({
			timeout: 60000,
		});
		await expect(wordpress.locator('#blogname')).toHaveValue(blogName);
	});

	test('activated plugin persists after reload', async ({
		website,
		wordpress,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		await website.goto('./?url=/wp-admin/plugins.php');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `Plugin Persist ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		// Wait for reboot, navigate to plugins
		await website.waitForNestedIframes();
		await website.ensureSiteManagerIsClosed();

		// Navigate to plugins via admin menu
		await wordpress
			.locator('#menu-plugins a.menu-top')
			.evaluate((el) => (el as HTMLElement).click());
		await expect(wordpress.locator('.plugins')).toBeVisible({
			timeout: 60000,
		});

		// Activate Hello Dolly if inactive
		const helloDolly = wordpress.locator('tr[data-slug="hello-dolly"]');
		const activateLink = helloDolly.locator('a.activate');
		if (
			await activateLink.isVisible({ timeout: 5000 }).catch(() => false)
		) {
			await activateLink.click();
			await expect(
				wordpress.locator('#message').filter({ hasText: 'activated' })
			).toBeVisible({ timeout: 30000 });
		}

		// Verify active
		await expect(helloDolly).toHaveClass(/active/, { timeout: 10000 });

		// Wait for snapshot
		await page.waitForTimeout(12000);

		// Reload
		const url = website.page.url();
		await page.goto(url);
		await website.waitForNestedIframes();

		// Navigate to plugins
		await wordpress
			.locator('#menu-plugins a.menu-top')
			.evaluate((el) => (el as HTMLElement).click());
		await expect(wordpress.locator('.plugins')).toBeVisible({
			timeout: 60000,
		});

		// Hello Dolly should still be active
		await expect(
			wordpress.locator('tr[data-slug="hello-dolly"]')
		).toHaveClass(/active/, { timeout: 30000 });
	});

	test('uploaded file persists after reload', async ({
		website,
		wordpress,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		await website.goto('./?url=/wp-admin/');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `File Persist ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		await website.waitForNestedIframes();

		// Create a test file via the playground API
		await website.page.waitForFunction(() =>
			Boolean((window as any).playground)
		);
		await website.page.evaluate(async () => {
			const playground = (window as any).playground;
			await playground.writeFile(
				'/wordpress/wp-content/test-persist.txt',
				'persist-check-12345'
			);
		});

		// Wait for snapshot
		await page.waitForTimeout(12000);

		// Reload
		const url = website.page.url();
		await page.goto(url);
		await website.waitForNestedIframes();
		await website.page.waitForFunction(() =>
			Boolean((window as any).playground)
		);

		// Check file exists
		const fileContent = await website.page.evaluate(async () => {
			const playground = (window as any).playground;
			try {
				return await playground.readFileAsText(
					'/wordpress/wp-content/test-persist.txt'
				);
			} catch {
				return 'FILE_NOT_FOUND';
			}
		});
		expect(fileContent).toBe('persist-check-12345');
	});
});

test.describe('Remote sync', () => {
	test('constructs correct remote URL with database name', async ({
		website,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		await website.goto('./');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `Remote URL ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		// Fill remote settings
		await website.page.getByLabel('Server URL').fill(POUCHDB_URL);
		await website.page.getByLabel('Database name').fill(TEST_DB_NAME);

		// Capture logs during reload
		const logs: string[] = [];
		page.on('console', (msg) => logs.push(msg.text()));

		await website.page
			.getByRole('button', { name: 'Save & Reload' })
			.click();
		await website.waitForNestedIframes();

		// Verify the boot config has the full URL
		const bootLog = logs.find((l) =>
			l.includes('[CouchbaseSync] Boot config:')
		);
		expect(bootLog).toContain(`${POUCHDB_URL}/${TEST_DB_NAME}`);
	});

	test('replication pushes data to remote server', async ({
		website,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		const dbName = `push-test-${Date.now()}`;
		// Create remote DB via HTTP PUT (pouchdb-server requires this)
		const { execSync } = require('child_process');
		execSync(`curl -s -X PUT http://127.0.0.1:${POUCHDB_PORT}/${dbName}`);

		await website.goto('./');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `Push Test ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		// Configure remote sync
		await website.page.getByLabel('Server URL').fill(POUCHDB_URL);
		await website.page.getByLabel('Database name').fill(dbName);

		const logs: string[] = [];
		page.on('console', (msg) => logs.push(msg.text()));

		await website.page
			.getByRole('button', { name: 'Save & Reload' })
			.click();
		await website.waitForNestedIframes();

		// Wait for replication (snapshot + push)
		await page.waitForTimeout(20000);

		const syncLogs = logs.filter(
			(l) => l.includes('CouchbaseSync') || l.includes('Replication')
		);
		// eslint-disable-next-line no-console
		console.log('Sync logs:', syncLogs.join('\n'));

		// Check remote has data
		const count = await getRemoteDocCount(dbName);
		// eslint-disable-next-line no-console
		console.log(`Remote doc count: ${count}`);

		expect(count).toBeGreaterThan(0);
	});

	test('blog name change syncs to remote', async ({
		website,
		wordpress,
		browserName,
		page,
	}) => {
		test.skip(browserName !== 'chromium', 'Requires Chromium.');

		const dbName = `blog-sync-${Date.now()}`;
		const { execSync } = require('child_process');
		execSync(`curl -s -X PUT http://127.0.0.1:${POUCHDB_PORT}/${dbName}`);

		await website.goto('./?url=/wp-admin/');
		await website.ensureSiteManagerIsOpen();
		await saveSiteToCouchbase(website.page, `Blog Sync ${Date.now()}`);
		await expect(
			website.page.getByLabel('Playground title')
		).not.toContainText('Unsaved Playground', { timeout: 90000 });

		// Configure remote
		await website.page.getByLabel('Server URL').fill(POUCHDB_URL);
		await website.page.getByLabel('Database name').fill(dbName);
		await website.page
			.getByRole('button', { name: 'Save & Reload' })
			.click();
		await website.waitForNestedIframes();

		// Wait for initial sync
		await page.waitForTimeout(15000);

		// Change blog name
		await website.ensureSiteManagerIsClosed();
		await wordpress
			.locator('#menu-settings a.menu-top')
			.evaluate((el) => (el as HTMLElement).click());
		await expect(wordpress.locator('#blogname')).toBeVisible({
			timeout: 60000,
		});

		const blogName = `Synced Blog ${Date.now()}`;
		await wordpress.locator('#blogname').fill(blogName);
		await wordpress.locator('#submit').click();
		await expect(
			wordpress.locator('#setting-error-settings_updated')
		).toBeVisible({ timeout: 30000 });

		// Wait for snapshot + replication
		await page.waitForTimeout(15000);

		// Check remote
		const remoteBlogname = await getRemoteOption(dbName, 'blogname');
		// eslint-disable-next-line no-console
		console.log(
			`Remote blogname: expected="${blogName}" got="${remoteBlogname}"`
		);
		expect(remoteBlogname).toBe(blogName);
	});
});
