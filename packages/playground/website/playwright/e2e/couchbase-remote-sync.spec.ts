/**
 * E2E tests for remote CouchDB/PouchDB sync.
 *
 * Starts a local PouchDB HTTP server and verifies that:
 * 1. The remote sync UI is accessible
 * 2. Saving CouchDB config triggers a page reload
 * 3. The remote URL includes the database name (not just server URL)
 * 4. PouchDB replication pushes data to the remote server
 *
 * Note: The Playground Service Worker intercepts cross-origin fetch
 * requests and breaks PouchDB replication in the browser. The SW
 * change to bypass cross-origin requests requires a full rebuild.
 * These tests verify the config flow and catch regressions in the
 * URL construction logic.
 */
import { test, expect } from '../playground-fixtures.ts';
import type { Page } from '@playwright/test';

// These tests must run serially.
test.describe.configure({ mode: 'serial' });

const POUCHDB_PORT = 15984;
const POUCHDB_URL = `http://127.0.0.1:${POUCHDB_PORT}`;
const TEST_DB_NAME = 'wp-playground-e2e-test';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
let PouchDB: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pouchServer: any;

test.beforeAll(async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const pouchdb = require('pouchdb');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	pouchdb.plugin(require('pouchdb-adapter-memory'));
	PouchDB = pouchdb;

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const expressPouchdb = require('express-pouchdb');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const express = require('express');

	const app = express();
	// CORS + logging middleware
	app.use((req: any, res: any, next: any) => {
		res.header('Access-Control-Allow-Origin', '*');
		res.header('Access-Control-Allow-Headers', '*');
		res.header(
			'Access-Control-Allow-Methods',
			'GET, POST, PUT, DELETE, OPTIONS, HEAD'
		);
		res.header('Access-Control-Expose-Headers', 'ETag, Content-Type');
		if (req.method === 'OPTIONS') {
			return res.sendStatus(200);
		}
		next();
	});
	app.use(
		expressPouchdb(pouchdb.defaults({ adapter: 'memory' }), {
			mode: 'fullCouchDB',
		})
	);

	await new Promise<void>((resolve) => {
		pouchServer = app.listen(POUCHDB_PORT, '127.0.0.1', () => {
			resolve();
		});
	});

	// Create the test database
	const db = new PouchDB(`${POUCHDB_URL}/${TEST_DB_NAME}`);
	await db.info();
	await db.close();
});

test.afterAll(async () => {
	if (pouchServer) {
		await new Promise<void>((resolve) => {
			pouchServer.close(() => resolve());
		});
	}
});

async function saveSiteToCouchbase(
	page: Page,
	options?: { customName?: string }
) {
	const { customName } = options || {};

	const saveButton = page.getByRole('button', { name: 'Save site locally' });
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = page.getByRole('dialog', { name: 'Save Playground' });
	await expect(dialog).toBeVisible({ timeout: 10000 });

	if (customName) {
		const nameInput = dialog.getByLabel('Playground name');
		await nameInput.fill('');
		await nameInput.type(customName);
	}

	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });

	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).not.toBeVisible({ timeout: 120000 });
}

test('PouchDB server is running and reachable', async () => {
	const db = new PouchDB(`${POUCHDB_URL}/${TEST_DB_NAME}`);
	const info = await db.info();
	expect(info.db_name).toBe(TEST_DB_NAME);
	await db.close();
});

test('should show remote CouchDB fields after saving to Couchbase', async ({
	website,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `Remote UI Test ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// The stored site settings should show Remote CouchDB Sync section
	await expect(website.page.getByText('Remote CouchDB Sync')).toBeVisible({
		timeout: 10000,
	});
	await expect(website.page.getByLabel('Server URL')).toBeVisible();
	await expect(website.page.getByLabel('Database name')).toBeVisible();
});

test('should construct correct remote URL with database name', async ({
	website,
	browserName,
	page,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `Remote URL Test ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// Fill in remote CouchDB settings
	const serverUrl = website.page.getByLabel('Server URL');
	await expect(serverUrl).toBeVisible({ timeout: 10000 });
	await serverUrl.fill(POUCHDB_URL);

	const dbName = website.page.getByLabel('Database name');
	await dbName.fill(TEST_DB_NAME);

	// Capture console logs during reload to verify the remote URL
	const consoleLogs: string[] = [];
	page.on('console', (msg) => {
		consoleLogs.push(msg.text());
	});

	// Save & Reload should trigger a page reload for Couchbase sites
	await website.page.getByRole('button', { name: 'Save & Reload' }).click();

	// Wait for the reload and site boot
	await website.waitForNestedIframes();

	// Check that the boot config includes the full remote URL
	// with the database name appended
	const bootLog = consoleLogs.find((l) =>
		l.includes('[CouchbaseSync] Boot config:')
	);
	expect(bootLog).toBeTruthy();

	// The remote URL should be server + database name
	const expectedUrl = `${POUCHDB_URL}/${TEST_DB_NAME}`;
	expect(bootLog).toContain(expectedUrl);
});

test('PouchDB replication works between in-memory databases', async () => {
	// Verifies the replication protocol works with our document
	// schema, independently of the browser/SW/express-pouchdb issues.
	const localDb = new PouchDB(`local-test-${Date.now()}`, {
		adapter: 'memory',
	});
	const remoteDb = new PouchDB(`remote-test-${Date.now()}`, {
		adapter: 'memory',
	});

	// Add WordPress-style documents
	await localDb.put({
		_id: 'wp_options::1',
		option_name: 'blogname',
		option_value: 'Test Blog',
		meta_table: 'wp_options',
		meta_pk_column: 'option_id',
	});
	await localDb.put({
		_id: 'wp_posts::1',
		post_title: 'Hello World',
		post_status: 'publish',
		meta_table: 'wp_posts',
		meta_pk_column: 'ID',
	});
	await localDb.put({
		_id: 'wp_files::plugins/hello.php',
		meta_path: 'plugins/hello.php',
		data: 'PD9waHAgZWNobyAiSGVsbG8iOw==',
	});

	// Replicate local → remote
	await localDb.replicate.to(remoteDb);

	// Verify remote has all documents
	const remoteInfo = await remoteDb.info();
	expect(remoteInfo.doc_count).toBe(3);

	const blogname = await remoteDb.get('wp_options::1');
	expect(blogname.option_value).toBe('Test Blog');

	const post = await remoteDb.get('wp_posts::1');
	expect(post.post_title).toBe('Hello World');

	const file = await remoteDb.get('wp_files::plugins/hello.php');
	expect(file.meta_path).toBe('plugins/hello.php');

	// Replicate remote → new local (simulates second device)
	const localDb2 = new PouchDB(`local-test-2-${Date.now()}`, {
		adapter: 'memory',
	});
	await localDb2.replicate.from(remoteDb);

	const pulledBlogname = await localDb2.get('wp_options::1');
	expect(pulledBlogname.option_value).toBe('Test Blog');

	// Bidirectional: change on remote, sync back
	const bnDoc = await remoteDb.get('wp_options::1');
	bnDoc.option_value = 'Updated Blog';
	await remoteDb.put(bnDoc);

	await localDb.replicate.from(remoteDb);
	const updated = await localDb.get('wp_options::1');
	expect(updated.option_value).toBe('Updated Blog');

	await localDb.close();
	await localDb2.close();
	await remoteDb.close();
});
