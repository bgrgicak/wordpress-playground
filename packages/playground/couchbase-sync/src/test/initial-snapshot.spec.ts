/**
 * Tests that verify the sync pipeline captures the FULL initial
 * WordPress state into PouchDB — not just incremental changes.
 *
 * These tests expose three critical issues:
 * 1. Database rows must be captured on first save (not just new changes)
 * 2. ALL wp-content files must be captured (not just newly written ones)
 * 3. On restore, data must be available BEFORE WordPress renders
 */
import type { PHP } from '@php-wasm/universal';
import type { SQLJournalEntry } from '@wp-playground/sync';
import {
	installSqlSyncMuPlugin,
	journalSQLQueries,
	replaySQLJournal,
} from '@wp-playground/sync';
import {
	getSqliteDriverModule,
	getWordPressModule,
} from '@wp-playground/wordpress-builds';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { bootWordPressAndRequestHandler } from '@wp-playground/wordpress';
import { loadNodeRuntime } from '@php-wasm/node';
import { CouchbaseDatabase } from '../lib/couchbase-database';
import { snapshotSqlToPouchDB } from '../lib/snapshot-to-pouchdb';
import { snapshotFilesToPouchDB } from '../lib/snapshot-to-pouchdb';
import { restoreFromCouchbase } from '../lib/restore-from-couchbase';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PouchDB = require('pouchdb');
// eslint-disable-next-line @typescript-eslint/no-require-imports
PouchDB.plugin(require('pouchdb-adapter-memory'));

let wpModule: Awaited<ReturnType<typeof getWordPressModule>>;
let sqliteModule: Awaited<ReturnType<typeof getSqliteDriverModule>>;

beforeAll(async () => {
	[wpModule, sqliteModule] = await Promise.all([
		getWordPressModule(),
		getSqliteDriverModule('v2.1.16'),
	]);
}, 30_000);

async function bootSite(siteUrl: string): Promise<PHP> {
	const handler = await bootWordPressAndRequestHandler({
		createPhpRuntime: async () =>
			await loadNodeRuntime(RecommendedPHPVersion),
		siteUrl,
		wordPressZip: wpModule,
		sqliteIntegrationPluginZip: sqliteModule,
	});
	return handler.getPrimaryPhp();
}

describe('Initial snapshot: database rows', () => {
	it(
		'captures ALL existing wp_options rows into PouchDB on first save',
		async () => {
			const site = await bootSite('http://snapshot-test.test/');
			await installSqlSyncMuPlugin(site);

			// WordPress has many built-in options after install
			const result = await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				global $wpdb;
				echo $wpdb->get_var("SELECT COUNT(*) FROM wp_options");
			`,
			});
			const optionCount = parseInt(
				new TextDecoder().decode(result.bytes).trim(),
				10
			);
			expect(optionCount).toBeGreaterThan(50); // WP has ~100 default options

			// Snapshot the existing database into PouchDB
			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `snap-test-${Date.now()}`,
			});
			await cbDb.open();

			const sqlCount = await snapshotSqlToPouchDB(site, cbDb);
			expect(sqlCount).toBeGreaterThan(50);

			// Verify wp_options docs in PouchDB
			const optionDocs = await cbDb.getAllDocuments('wp_options');
			expect(optionDocs.length).toBeGreaterThan(50);

			// Verify specific well-known options exist
			const bodies = optionDocs.map((d) => d.body);
			const siteUrl = bodies.find((b) => b?.option_name === 'siteurl');
			expect(siteUrl).toBeDefined();

			const blogName = bodies.find((b) => b?.option_name === 'blogname');
			expect(blogName).toBeDefined();

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);

	it(
		'captures ALL existing wp_posts rows (including defaults)',
		async () => {
			const site = await bootSite('http://snapshot-posts.test/');
			await installSqlSyncMuPlugin(site);

			// WordPress creates a default "Hello world!" post
			const result = await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				global $wpdb;
				echo $wpdb->get_var("SELECT COUNT(*) FROM wp_posts");
			`,
			});
			const postCount = parseInt(
				new TextDecoder().decode(result.bytes).trim(),
				10
			);
			expect(postCount).toBeGreaterThan(0);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `snap-posts-${Date.now()}`,
			});
			await cbDb.open();

			await snapshotSqlToPouchDB(site, cbDb);

			const postDocs = await cbDb.getAllDocuments('wp_posts');
			expect(postDocs.length).toBe(postCount);

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);

	it(
		'captures wp_users and wp_usermeta rows',
		async () => {
			const site = await bootSite('http://snapshot-users.test/');
			await installSqlSyncMuPlugin(site);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `snap-users-${Date.now()}`,
			});
			await cbDb.open();

			await snapshotSqlToPouchDB(site, cbDb);

			const userDocs = await cbDb.getAllDocuments('wp_users');
			expect(userDocs.length).toBeGreaterThan(0); // At least admin user

			const usermetaDocs = await cbDb.getAllDocuments('wp_usermeta');
			expect(usermetaDocs.length).toBeGreaterThan(0);

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);
});

describe('Initial snapshot: filesystem', () => {
	it(
		'captures ALL existing wp-content files into PouchDB',
		async () => {
			const site = await bootSite('http://snapshot-fs.test/');

			// Count files in wp-content
			const result = await site.run({
				code: `<?php
				$count = 0;
				$iter = new RecursiveIteratorIterator(
					new RecursiveDirectoryIterator('/wordpress/wp-content',
						RecursiveDirectoryIterator::SKIP_DOTS)
				);
				foreach ($iter as $file) {
					if ($file->isFile() &&
						!str_contains($file->getPathname(), '.ht.sqlite')) {
						$count++;
					}
				}
				echo $count;
			`,
			});
			const fileCount = parseInt(
				new TextDecoder().decode(result.bytes).trim(),
				10
			);
			expect(fileCount).toBeGreaterThan(10); // WP has many default files

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `snap-fs-${Date.now()}`,
			});
			await cbDb.open();

			const snapshotCount = await snapshotFilesToPouchDB(site, cbDb);
			expect(snapshotCount).toBe(fileCount);

			const storedFiles = await cbDb.getAllFiles();
			expect(storedFiles.length).toBe(fileCount);

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);

	it(
		'captures default themes and plugins, not just installed ones',
		async () => {
			const site = await bootSite('http://snapshot-themes.test/');

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `snap-themes-${Date.now()}`,
			});
			await cbDb.open();

			await snapshotFilesToPouchDB(site, cbDb);

			const files = await cbDb.getAllFiles();
			const paths = files.map((f) => f.path);

			// Default theme files should be present
			const hasThemeFiles = paths.some((p) => p.startsWith('themes/'));
			expect(hasThemeFiles).toBe(true);

			// index.php should be present
			const hasIndex = paths.some((p) => p === 'index.php');
			expect(hasIndex).toBe(true);

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);
});

describe('Restore completeness', () => {
	it(
		'restores database rows so WordPress reads them',
		async () => {
			// Site A: create a post, snapshot to PouchDB
			const siteA = await bootSite('http://restore-a.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'Snapshot Post', 'post_status' => 'publish', 'post_author' => 1]);
				update_option('snapshot_test', 'snapshot_value');
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `restore-test-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			// Site B: fresh WordPress, restore from PouchDB
			const siteB = await bootSite('http://restore-b.test/');
			await installSqlSyncMuPlugin(siteB);

			const { sqlCount } = await restoreFromCouchbase(siteB, cbDb);
			expect(sqlCount).toBeGreaterThan(0);

			// Verify post exists on site B
			const postResult = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
				$titles = array_map(function($p) { return $p->post_title; }, $posts);
				echo json_encode($titles);
			`,
			});
			const titles = JSON.parse(
				new TextDecoder().decode(postResult.bytes)
			);
			expect(titles).toContain('Snapshot Post');

			// Verify option exists
			const optResult = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				echo get_option('snapshot_test', 'MISSING');
			`,
			});
			expect(new TextDecoder().decode(optResult.bytes)).toBe(
				'snapshot_value'
			);

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);

	it(
		'restores files so WordPress can read them',
		async () => {
			const siteA = await bootSite('http://restore-fs-a.test/');

			// Write a custom file
			siteA.writeFile(
				'/wordpress/wp-content/test-restore.txt',
				'restored content'
			);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `restore-fs-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotFilesToPouchDB(siteA, cbDb);

			// Verify file is in PouchDB
			const files = await cbDb.getAllFiles();
			const testFile = files.find((f) => f.path === 'test-restore.txt');
			expect(testFile).toBeDefined();

			// Site B: restore files
			const siteB = await bootSite('http://restore-fs-b.test/');
			const { fileCount } = await restoreFromCouchbase(siteB, cbDb);
			expect(fileCount).toBeGreaterThan(0);

			// Verify file exists on site B
			const content = siteB.readFileAsText(
				'/wordpress/wp-content/test-restore.txt'
			);
			expect(content).toBe('restored content');

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});
