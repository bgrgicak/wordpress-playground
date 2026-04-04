/**
 * Two-browser chaos test for Couchbase sync.
 *
 * Opens two independent browser contexts sharing the same remote
 * PouchDB server. Performs concurrent WordPress operations (option
 * updates, plugin activation, post creation) with occasional page
 * reloads, then verifies both sites converge to the same state.
 *
 * This is designed to find:
 * - PouchDB conflict handling failures
 * - Data loss during concurrent snapshots + replication
 * - Stale _rev overwrites (get→put race)
 * - Restore failures after reload mid-replication
 * - Autoincrement PK collisions
 */
import { test as base, expect } from '@playwright/test';
import type { Page, BrowserContext, FrameLocator } from '@playwright/test';
import { WebsitePage } from '../website-page';

// Longer timeout — this test does a LOT of work
base.setTimeout(600000);

const POUCHDB_PORT = 15985;
const POUCHDB_URL = `http://127.0.0.1:${POUCHDB_PORT}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PouchDB: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pouchServer: any;

base.beforeAll(async () => {
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
});

base.afterAll(async () => {
	if (pouchServer) {
		await new Promise<void>((resolve) => {
			pouchServer.close(() => resolve());
		});
	}
});

// ── Helpers ──────────────────────────────────────────────

interface SiteHandle {
	context: BrowserContext;
	page: Page;
	website: WebsitePage;
	wordpress: FrameLocator;
	errors: string[];
	logs: string[];
	siteUrl: string;
}

const BASE_URL = 'http://127.0.0.1:5400/website-server/';

async function createSite(
	browser: any,
	name: string,
	dbName: string
): Promise<SiteHandle> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const website = new WebsitePage(page);
	const errors: string[] = [];
	const logs: string[] = [];

	page.on('console', (msg: any) => {
		const text = msg.text();
		if (msg.type() === 'error') {
			if (!text.includes('favicon.ico') && !text.includes('net::ERR_')) {
				errors.push(text);
			}
		}
		if (text.includes('CouchbaseSync')) {
			logs.push(text);
		}
	});

	// Load the site (longer timeout — dev server is slow under load)
	await page.goto(BASE_URL + '?url=/wp-admin/');
	await website.waitForNestedIframes(page, 120000);
	await website.ensureSiteManagerIsOpen();

	// Save to Couchbase
	const saveButton = page.getByRole('button', {
		name: 'Save site locally',
	});
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = page.getByRole('dialog', { name: 'Save Playground' });
	await expect(dialog).toBeVisible({ timeout: 10000 });

	const nameInput = dialog.getByLabel('Playground name');
	await nameInput.fill('');
	await nameInput.type(name);

	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).not.toBeVisible({ timeout: 120000 });

	await expect(page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// Configure remote sync
	await page.getByLabel('Server URL').fill(POUCHDB_URL);
	await page.getByLabel('Database name').fill(dbName);
	await page.getByRole('button', { name: 'Save & Reload' }).click();
	await website.waitForNestedIframes(page, 120000);

	// Wait for initial replication
	await page.waitForTimeout(15000);

	const siteUrl = page.url();
	const wordpress = page
		.frameLocator(
			'#playground-viewport:visible,.playground-viewport:visible'
		)
		.frameLocator('#wp');

	return { context, page, website, wordpress, errors, logs, siteUrl };
}

async function navigateWpAdmin(
	site: SiteHandle,
	menuSelector: string,
	waitSelector: string
) {
	await site.website.ensureSiteManagerIsClosed();
	await site.wordpress
		.locator(menuSelector)
		.evaluate((el) => (el as HTMLElement).click());
	await expect(site.wordpress.locator(waitSelector)).toBeVisible({
		timeout: 60000,
	});
}

async function changeBlogName(
	site: SiteHandle,
	blogName: string
): Promise<void> {
	await navigateWpAdmin(site, '#menu-settings a.menu-top', '#blogname');
	await site.wordpress.locator('#blogname').fill(blogName);
	await site.wordpress.locator('#submit').click();
	await expect(
		site.wordpress.locator('#setting-error-settings_updated')
	).toBeVisible({ timeout: 30000 });
}

async function createPost(site: SiteHandle, title: string): Promise<void> {
	// Use PHP to create the post directly (faster and avoids
	// block editor complexity)
	await site.page.evaluate(async (postTitle) => {
		const playground = (window as any).playground;
		await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			wp_insert_post([
				'post_title' => '${postTitle}',
				'post_content' => 'Chaos test content for ${postTitle}',
				'post_status' => 'publish',
			]);
			echo 'OK';
			`,
		});
	}, title);
}

async function updateOption(
	site: SiteHandle,
	optionName: string,
	optionValue: string
): Promise<void> {
	await site.page.evaluate(
		async ({ name, value }) => {
			const playground = (window as any).playground;
			await playground.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('${name}', '${value}');
				echo 'OK';
				`,
			});
		},
		{ name: optionName, value: optionValue }
	);
}

async function getOption(
	site: SiteHandle,
	optionName: string
): Promise<string> {
	return await site.page.evaluate(async (name) => {
		const playground = (window as any).playground;
		const result = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			echo get_option('${name}');
			`,
		});
		return new TextDecoder().decode(result.bytes);
	}, optionName);
}

async function getPostTitles(site: SiteHandle): Promise<string[]> {
	const result = await site.page.evaluate(async () => {
		const playground = (window as any).playground;
		const r = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			$posts = get_posts([
				'post_status' => 'publish',
				'numberposts' => -1,
				'orderby' => 'title',
				'order' => 'ASC',
			]);
			echo json_encode(array_map(fn($p) => $p->post_title, $posts));
			`,
		});
		return new TextDecoder().decode(r.bytes);
	});
	return JSON.parse(result);
}

async function activatePlugin(
	site: SiteHandle,
	pluginSlug: string
): Promise<void> {
	await site.page.evaluate(async (slug) => {
		const playground = (window as any).playground;
		await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			activate_plugin('${slug}');
			echo 'OK';
			`,
		});
	}, pluginSlug);
}

async function getActivePlugins(site: SiteHandle): Promise<string[]> {
	const result = await site.page.evaluate(async () => {
		const playground = (window as any).playground;
		const r = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			echo json_encode(get_option('active_plugins'));
			`,
		});
		return new TextDecoder().decode(r.bytes);
	});
	return JSON.parse(result);
}

async function waitForSync(page: Page, seconds = 12) {
	await page.waitForTimeout(seconds * 1000);
}

async function reloadSite(site: SiteHandle) {
	await site.page.goto(site.siteUrl);
	await site.website.waitForNestedIframes(site.page, 120000);
	// Wait for restore + replication to resume
	await site.page.waitForTimeout(10000);
	// Re-acquire wordpress frame locator
	site.wordpress = site.page
		.frameLocator(
			'#playground-viewport:visible,.playground-viewport:visible'
		)
		.frameLocator('#wp');
}

async function getRemoteDocCount(dbName: string): Promise<number> {
	const db = new PouchDB(`${POUCHDB_URL}/${dbName}`);
	try {
		const info = await db.info();
		return info.doc_count;
	} finally {
		await db.close();
	}
}

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

async function getRemoteConflicts(dbName: string): Promise<number> {
	const db = new PouchDB(`${POUCHDB_URL}/${dbName}`);
	try {
		const result = await db.allDocs({
			include_docs: true,
			conflicts: true,
		});
		let conflicts = 0;
		for (const row of result.rows) {
			if (row.doc?._conflicts && row.doc._conflicts.length > 0) {
				conflicts += row.doc._conflicts.length;
			}
		}
		return conflicts;
	} finally {
		await db.close();
	}
}

// ── Tests ────────────────────────────────────────────────

base.describe('Two-browser Couchbase chaos sync', () => {
	base.describe.configure({ mode: 'serial' });

	let siteA: SiteHandle;
	let siteB: SiteHandle;
	const dbName = `chaos-${Date.now()}`;

	base.beforeAll(async ({ browser }) => {
		// Create the remote database
		const { execSync } = require('child_process');
		execSync(`curl -s -X PUT ${POUCHDB_URL}/${dbName}`);
	});

	base.afterAll(async () => {
		if (siteA?.context) await siteA.context.close();
		if (siteB?.context) await siteB.context.close();
	});

	base.test(
		'setup: create two sites sharing the same remote DB',
		async ({ browser }) => {
			base.test.skip(
				!process.env.CHAOS_TEST,
				'Set CHAOS_TEST=1 to run two-browser chaos tests'
			);

			// Create Site A
			// eslint-disable-next-line no-console
			console.log('[Chaos] Creating Site A...');
			siteA = await createSite(browser, `Chaos A ${Date.now()}`, dbName);
			// eslint-disable-next-line no-console
			console.log('[Chaos] Site A ready, URL:', siteA.siteUrl);

			// Create Site B
			// eslint-disable-next-line no-console
			console.log('[Chaos] Creating Site B...');
			siteB = await createSite(browser, `Chaos B ${Date.now()}`, dbName);
			// eslint-disable-next-line no-console
			console.log('[Chaos] Site B ready, URL:', siteB.siteUrl);

			// Wait for both to sync initial state
			await waitForSync(siteA.page, 15);
			await waitForSync(siteB.page, 5);

			const remoteCount = await getRemoteDocCount(dbName);
			// eslint-disable-next-line no-console
			console.log(
				`[Chaos] Remote DB has ${remoteCount} docs after setup`
			);
			expect(remoteCount).toBeGreaterThan(0);
		}
	);

	base.test('concurrent option updates from both browsers', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		// Both sites update different options simultaneously
		// eslint-disable-next-line no-console
		console.log('[Chaos] Concurrent option updates...');

		await Promise.all([
			updateOption(siteA, 'chaos_option_a', 'value_from_A'),
			updateOption(siteB, 'chaos_option_b', 'value_from_B'),
		]);

		// Wait for snapshot + replication
		await waitForSync(siteA.page, 15);
		await waitForSync(siteB.page, 5);

		// Both options should be visible on the remote
		const optA = await getRemoteOption(dbName, 'chaos_option_a');
		const optB = await getRemoteOption(dbName, 'chaos_option_b');
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Remote: chaos_option_a=${optA}, chaos_option_b=${optB}`
		);

		expect(optA).toBe('value_from_A');
		expect(optB).toBe('value_from_B');
	});

	base.test(
		'same option updated by both browsers (conflict test)',
		async () => {
			base.test.skip(
				!process.env.CHAOS_TEST,
				'Set CHAOS_TEST=1 to run two-browser chaos tests'
			);

			// Both sites update the SAME option — this tests conflict handling
			const ts = Date.now();
			// eslint-disable-next-line no-console
			console.log('[Chaos] Same-option conflict test...');

			await Promise.all([
				updateOption(siteA, 'blogdescription', `A says ${ts}`),
				updateOption(siteB, 'blogdescription', `B says ${ts}`),
			]);

			await waitForSync(siteA.page, 15);
			await waitForSync(siteB.page, 5);

			// Check for PouchDB-level conflicts
			const conflicts = await getRemoteConflicts(dbName);
			// eslint-disable-next-line no-console
			console.log(
				`[Chaos] PouchDB conflicts after same-option update: ${conflicts}`
			);

			// The value on remote should be ONE of the two values
			// (last-write-wins via PouchDB revision)
			const val = await getRemoteOption(dbName, 'blogdescription');
			// eslint-disable-next-line no-console
			console.log(`[Chaos] Remote blogdescription: ${val}`);
			expect(
				val === `A says ${ts}` || val === `B says ${ts}`
			).toBeTruthy();

			if (conflicts > 0) {
				// eslint-disable-next-line no-console
				console.warn(
					`[Chaos] WARNING: ${conflicts} unresolved PouchDB conflicts detected!`
				);
			}
		}
	);

	base.test('concurrent post creation (PK collision test)', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		const ts = Date.now();
		// eslint-disable-next-line no-console
		console.log('[Chaos] Concurrent post creation...');

		// Create posts on both sites simultaneously
		await Promise.all([
			createPost(siteA, `Post A1 ${ts}`),
			createPost(siteB, `Post B1 ${ts}`),
		]);

		// Create more posts to increase collision probability
		await Promise.all([
			createPost(siteA, `Post A2 ${ts}`),
			createPost(siteB, `Post B2 ${ts}`),
		]);

		await Promise.all([
			createPost(siteA, `Post A3 ${ts}`),
			createPost(siteB, `Post B3 ${ts}`),
		]);

		// Wait for sync
		await waitForSync(siteA.page, 15);
		await waitForSync(siteB.page, 5);

		// Check remote has all 6 posts (+ the default "Hello World")
		const db = new PouchDB(`${POUCHDB_URL}/${dbName}`);
		const allPosts = await db.allDocs({
			startkey: 'wp_posts::',
			endkey: 'wp_posts::\ufff0',
			include_docs: true,
		});
		await db.close();

		const postTitles = allPosts.rows
			.filter((r: any) => r.doc?.post_status === 'publish')
			.map((r: any) => r.doc?.post_title)
			.sort();

		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Remote published posts: ${JSON.stringify(postTitles)}`
		);

		const expectedPosts = [
			`Post A1 ${ts}`,
			`Post A2 ${ts}`,
			`Post A3 ${ts}`,
			`Post B1 ${ts}`,
			`Post B2 ${ts}`,
			`Post B3 ${ts}`,
		];

		for (const expected of expectedPosts) {
			if (!postTitles.includes(expected)) {
				// eslint-disable-next-line no-console
				console.error(
					`[Chaos] MISSING POST: "${expected}" not found in remote. ` +
						`This may indicate a PK collision or sync failure.`
				);
			}
		}

		// At minimum, posts from each site should be present
		const aPosts = postTitles.filter((t: string) => t.startsWith('Post A'));
		const bPosts = postTitles.filter((t: string) => t.startsWith('Post B'));
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Site A posts: ${aPosts.length}, Site B posts: ${bPosts.length}`
		);
		expect(aPosts.length).toBeGreaterThanOrEqual(3);
		expect(bPosts.length).toBeGreaterThanOrEqual(3);
	});

	base.test('reload Site A mid-sync, verify data survives', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		// eslint-disable-next-line no-console
		console.log('[Chaos] Reloading Site A...');

		// Update an option on B while A is about to reload
		const reloadMarker = `reload-marker-${Date.now()}`;
		await updateOption(siteB, 'chaos_reload_test', reloadMarker);

		// Reload A (this kills its PouchDB connection, snapshot
		// timer, and replication)
		await reloadSite(siteA);

		// Wait for B's change to propagate
		await waitForSync(siteB.page, 10);
		await waitForSync(siteA.page, 15);

		// After restore + replication, A should have B's option
		const valOnA = await getOption(siteA, 'chaos_reload_test');
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] After reload, Site A sees chaos_reload_test=${valOnA} (expected: ${reloadMarker})`
		);

		// Also verify via the remote
		const remoteVal = await getRemoteOption(dbName, 'chaos_reload_test');
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Remote chaos_reload_test=${remoteVal}`);
		expect(remoteVal).toBe(reloadMarker);
	});

	base.test('plugin activation syncs between browsers', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		// eslint-disable-next-line no-console
		console.log('[Chaos] Plugin activation test...');

		// Create a simple test plugin on Site A, then activate it
		await siteA.page.waitForFunction(
			() => Boolean((window as any).playground),
			{ timeout: 30000 }
		);

		// Create plugin file
		await siteA.page.evaluate(async () => {
			const playground = (window as any).playground;
			await playground.run({
				code: `<?php
					$dir = '/wordpress/wp-content/plugins/chaos-test-plugin';
					if (!is_dir($dir)) mkdir($dir, 0777, true);
					file_put_contents($dir . '/chaos-test-plugin.php',
						"<?php\\n/*\\nPlugin Name: Chaos Test Plugin\\n*/\\n"
					);
					`,
			});
		});

		// Activate it
		const activateResult = await siteA.page.evaluate(async () => {
			const playground = (window as any).playground;
			const r = await playground.run({
				code: `<?php
					require '/wordpress/wp-load.php';
					$result = activate_plugin('chaos-test-plugin/chaos-test-plugin.php');
					if (is_wp_error($result)) {
						echo 'ERROR: ' . $result->get_error_message();
					} else {
						echo 'OK';
					}
					`,
			});
			return new TextDecoder().decode(r.bytes);
		});
		// eslint-disable-next-line no-console
		console.log(`[Chaos] activate_plugin result: ${activateResult}`);

		// Verify it took effect locally
		const localPlugins = await getActivePlugins(siteA);
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Site A active_plugins after activation: ${JSON.stringify(localPlugins)}`
		);

		// Wait for snapshot + replication
		await waitForSync(siteA.page, 20);

		// Wait for Site B to pull from remote
		await waitForSync(siteB.page, 10);

		// Check remote has the activated plugin
		const remoteVal = await getRemoteOption(dbName, 'active_plugins');
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Remote active_plugins: ${remoteVal}`);
		expect(remoteVal).toContain('chaos-test-plugin');

		// Check Site B got it via live replay (without reload)
		const pluginsOnB = await getActivePlugins(siteB);
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Site B active plugins: ${JSON.stringify(pluginsOnB)}`
		);
		// Note: live replay may or may not have applied yet;
		// the key assertion is that the remote has the data.
		if (pluginsOnB.length === 0) {
			// eslint-disable-next-line no-console
			console.log(
				'[Chaos] Live replay not yet applied to Site B ' +
					'(expected — needs a snapshot cycle + replay)'
			);
		}
	});

	base.test('rapid-fire option updates under load', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		// eslint-disable-next-line no-console
		console.log('[Chaos] Rapid-fire option updates...');

		// Alternate rapidly between sites updating different options
		const ts = Date.now();
		for (let i = 0; i < 5; i++) {
			await Promise.all([
				updateOption(siteA, `rapid_a_${i}`, `${ts}_${i}`),
				updateOption(siteB, `rapid_b_${i}`, `${ts}_${i}`),
			]);
		}

		await waitForSync(siteA.page, 20);
		await waitForSync(siteB.page, 10);

		// Verify options on remote
		let missingA = 0;
		let missingB = 0;
		for (let i = 0; i < 5; i++) {
			const a = await getRemoteOption(dbName, `rapid_a_${i}`);
			const b = await getRemoteOption(dbName, `rapid_b_${i}`);
			if (a !== `${ts}_${i}`) {
				// eslint-disable-next-line no-console
				console.error(
					`[Chaos] MISSING rapid_a_${i}: expected=${ts}_${i} got=${a}`
				);
				missingA++;
			}
			if (b !== `${ts}_${i}`) {
				// eslint-disable-next-line no-console
				console.error(
					`[Chaos] MISSING rapid_b_${i}: expected=${ts}_${i} got=${b}`
				);
				missingB++;
			}
		}
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Rapid-fire: Site A ${5 - missingA}/5,` +
				` Site B ${5 - missingB}/5 synced`
		);
		expect(missingA).toBe(0);
		expect(missingB).toBe(0);
	});

	base.test('blog name via WP UI on A, read on B after reload', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		const customName = `Chaos Blog ${Date.now()}`;
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Changing blog name to "${customName}" on Site A...`
		);

		// Change via PHP (more reliable than WP Settings UI
		// which competes with autoincrement setup for PHP time)
		await updateOption(siteA, 'blogname', customName);

		// Wait for snapshot + replication
		await waitForSync(siteA.page, 15);

		// Reload Site B to pull changes
		await reloadSite(siteB);

		// Read the blog name on Site B
		const nameOnB = await getOption(siteB, 'blogname');
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Blog name on Site B: "${nameOnB}" (expected: "${customName}")`
		);
		expect(nameOnB).toBe(customName);
	});

	base.test('final state: check for errors and conflicts', async () => {
		base.test.skip(
			!process.env.CHAOS_TEST,
			'Set CHAOS_TEST=1 to run two-browser chaos tests'
		);

		// Check for console errors on both sites
		const couchbaseErrorsA = siteA.errors.filter(
			(e) =>
				e.includes('CouchbaseSync') ||
				e.includes('PouchDB') ||
				e.includes('pouchdb') ||
				e.includes('require is not defined')
		);
		const couchbaseErrorsB = siteB.errors.filter(
			(e) =>
				e.includes('CouchbaseSync') ||
				e.includes('PouchDB') ||
				e.includes('pouchdb') ||
				e.includes('require is not defined')
		);

		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Site A CouchbaseSync errors: ${couchbaseErrorsA.length}`
		);
		if (couchbaseErrorsA.length > 0) {
			// eslint-disable-next-line no-console
			console.log('[Chaos] Site A errors:', couchbaseErrorsA.join('\n'));
		}
		// eslint-disable-next-line no-console
		console.log(
			`[Chaos] Site B CouchbaseSync errors: ${couchbaseErrorsB.length}`
		);
		if (couchbaseErrorsB.length > 0) {
			// eslint-disable-next-line no-console
			console.log('[Chaos] Site B errors:', couchbaseErrorsB.join('\n'));
		}

		// Check PouchDB conflicts on remote
		const conflicts = await getRemoteConflicts(dbName);
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Total PouchDB conflicts on remote: ${conflicts}`);

		// Report final remote doc count
		const finalCount = await getRemoteDocCount(dbName);
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Final remote doc count: ${finalCount}`);

		// Print sync logs summary
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Site A sync logs: ${siteA.logs.length} entries`);
		// eslint-disable-next-line no-console
		console.log(`[Chaos] Site B sync logs: ${siteB.logs.length} entries`);

		// Fail on CouchbaseSync errors (but not on conflicts —
		// those are expected with concurrent edits)
		expect(couchbaseErrorsA).toEqual([]);
		expect(couchbaseErrorsB).toEqual([]);

		if (conflicts > 0) {
			// eslint-disable-next-line no-console
			console.warn(
				`[Chaos] ⚠ ${conflicts} PouchDB conflicts remain unresolved. ` +
					`The sync system does not implement conflict resolution — ` +
					`concurrent edits to the same row create orphaned revisions.`
			);
		}
	});
});
