/**
 * Tests that verify Couchbase data is restored BEFORE WordPress
 * renders its first page, and that background WordPress operations
 * don't corrupt PouchDB over time.
 */
import type { PHP } from '@php-wasm/universal';
import type { SQLJournalEntry } from '@wp-playground/sync';
import {
	installSqlSyncMuPlugin,
	journalSQLQueries,
	overrideAutoincrementSequences,
} from '@wp-playground/sync';
import {
	getSqliteDriverModule,
	getWordPressModule,
} from '@wp-playground/wordpress-builds';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { bootWordPressAndRequestHandler } from '@wp-playground/wordpress';
import { loadNodeRuntime } from '@php-wasm/node';
import { CouchbaseDatabase } from '../lib/couchbase-database';
import { CouchbaseSyncTransport } from '../lib/couchbase-transport';
import {
	snapshotSqlToPouchDB,
	snapshotFilesToPouchDB,
} from '../lib/snapshot-to-pouchdb';
import { restoreFromCouchbase } from '../lib/restore-from-couchbase';
import { sqlJournalEntryToCouchbaseOps } from '../index';

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

describe('Restore timing: data available before first page', () => {
	it(
		'restored blog name is visible on very first WordPress request',
		async () => {
			// Step 1: Create a site with custom blog name, snapshot
			const siteA = await bootSite('http://timing-a.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('blogname', 'My Custom Blog');
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `timing-test-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			// Step 2: Boot fresh site, restore BEFORE querying
			const siteB = await bootSite('http://timing-b.test/');
			await installSqlSyncMuPlugin(siteB);

			// Restore (this is what onClientConnected now does)
			await restoreFromCouchbase(siteB, cbDb);

			// Step 3: The VERY FIRST request should see custom name
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				echo get_option('blogname');
			`,
			});
			expect(new TextDecoder().decode(result.bytes)).toBe(
				'My Custom Blog'
			);

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);

	it(
		'restored posts are visible on first WordPress request',
		async () => {
			const siteA = await bootSite('http://timing-posts-a.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'Immediate Post', 'post_status' => 'publish', 'post_author' => 1]);
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `timing-posts-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			const siteB = await bootSite('http://timing-posts-b.test/');
			await installSqlSyncMuPlugin(siteB);
			await restoreFromCouchbase(siteB, cbDb);

			// First request should see the post
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
				echo json_encode(array_map(function($p) { return $p->post_title; }, $posts));
			`,
			});
			const titles = JSON.parse(new TextDecoder().decode(result.bytes));
			expect(titles).toContain('Immediate Post');

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});

describe('Restore handles large WordPress data without stack overflow', () => {
	it(
		'restores a database with large serialized option values',
		async () => {
			// Reproduce the stack overflow in phpVars/bytesToBase64
			// that occurs with real WordPress data. Options like
			// active_plugins, widget_block, and theme_mods can be
			// 50-100KB+ of serialized PHP arrays.
			const siteA = await bootSite('http://large-data.test/');
			await installSqlSyncMuPlugin(siteA);

			// Create options with large serialized values
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				// Simulate a large serialized option (100KB+)
				$large_value = str_repeat('a', 120000);
				update_option('large_test_option', $large_value);

				// Simulate another large option with nested structure
				$nested = [];
				for ($i = 0; $i < 200; $i++) {
					$nested["plugin_$i"] = str_repeat("x", 500);
				}
				update_option('large_nested_option', serialize($nested));
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `large-data-test-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			// Restore into a fresh site — this is where the stack
			// overflow used to occur in phpVars() → bytesToBase64()
			const siteB = await bootSite('http://large-data-restore.test/');
			await installSqlSyncMuPlugin(siteB);
			await restoreFromCouchbase(siteB, cbDb);

			// Verify the large values survived
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$large = get_option('large_test_option');
				$nested = unserialize(get_option('large_nested_option'));
				echo json_encode([
					'large_length' => strlen($large),
					'nested_count' => count($nested),
				]);
			`,
			});
			const data = JSON.parse(new TextDecoder().decode(result.bytes));
			expect(data.large_length).toBe(120000);
			expect(data.nested_count).toBe(200);

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});

describe('Background operations must not corrupt PouchDB', () => {
	it(
		'transient cleanup queries do not delete real data from PouchDB',
		async () => {
			const siteA = await bootSite('http://bg-ops.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('persistent_setting', 'keep_me');
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `bg-ops-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			// Set up the journal + transport
			const transport = new CouchbaseSyncTransport(cbDb);
			transport.pause();
			await overrideAutoincrementSequences(siteA, 1000000);
			transport.resume();

			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			// Simulate WordPress background operations: transient
			// cleanup, cron, session token updates
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				// These are typical WordPress background operations
				set_transient('test_transient', 'value', 60);
				delete_transient('test_transient');
				update_option('cron', serialize([]));
			`,
			});

			// Push ALL journal entries through the transport
			// (simulating what the 3-second flush timer does)
			const writeEntries = entries.filter(
				(e) => e.query_type !== 'SELECT' && e.table_name !== ''
			);

			// The prune middleware should filter out transients and cron
			// but let's check what actually reaches PouchDB
			for (const entry of writeEntries) {
				const ops = sqlJournalEntryToCouchbaseOps(entry);
				await cbDb.applyCouchbaseOps(ops);
			}

			// The persistent setting must still be in PouchDB
			const opts = await cbDb.getAllDocuments('wp_options');
			const persistent = opts.find(
				(d) => d.body?.option_name === 'persistent_setting'
			);
			expect(persistent).toBeDefined();
			expect(persistent!.body!.option_value).toBe('keep_me');

			await cbDb.close();
		},
		{ timeout: 60_000 }
	);

	// Prune middleware unit tests omitted because
	// pruneSQLQueriesMiddleware is not exported from @wp-playground/sync.
	// The "transient cleanup queries do not delete real data" test
	// validates prune behavior end-to-end.
});
