/**
 * Regression tests for the data loss bug where:
 * 1. Save site to Couchbase
 * 2. Open in second tab (works)
 * 3. Deactivate a plugin → BOTH tabs lose all data
 *
 * Root causes tested:
 * - Setup artifacts (mu-plugin install, autoincrement override)
 *   poisoning PouchDB via the journal
 * - Transport sending stale changes during setup
 * - UPDATE operations with unparseable WHERE clauses silently dropped
 * - Restore followed by setup causing a race condition
 */
import type { PHP } from '@php-wasm/universal';
import type { SQLJournalEntry } from '@wp-playground/sync';
import {
	installSqlSyncMuPlugin,
	journalSQLQueries,
	overrideAutoincrementSequences,
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
import { CouchbaseSyncTransport } from '../lib/couchbase-transport';
import {
	snapshotSqlToPouchDB,
	snapshotFilesToPouchDB,
} from '../lib/snapshot-to-pouchdb';
import { restoreFromCouchbase } from '../lib/restore-from-couchbase';
import {
	sqlJournalEntryToCouchbaseOps,
	couchbaseChangeToSqlJournalEntry,
} from '../index';

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

describe('Regression: setup artifacts must not poison PouchDB', () => {
	it(
		'overrideAutoincrementSequences does not emit journal entries',
		async () => {
			const site = await bootSite('http://setup-poison.test/');
			await installSqlSyncMuPlugin(site);

			// Start journaling BEFORE overrideAutoincrementSequences
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(site, (e) => entries.push(e));

			// This used to generate INSERT/UPDATE on playground_sequence
			// and playground_variables that got captured by the journal
			await overrideAutoincrementSequences(site, 1000000);

			// Wait for any pending journal flushes
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Filter to only non-SELECT entries (the ones that would
			// corrupt PouchDB)
			const writeEntries = entries.filter(
				(e) => e.query_type !== 'SELECT' && e.table_name !== ''
			);

			// With the REPLAYING_SQL fix, there should be NO write
			// entries from the setup operations
			const setupEntries = writeEntries.filter(
				(e) =>
					e.table_name === 'playground_sequence' ||
					e.table_name === 'playground_variables' ||
					(e.query && e.query.includes('playground_'))
			);
			expect(setupEntries).toHaveLength(0);
		},
		{ timeout: 60_000 }
	);

	it(
		'transport.pause() prevents outbound changes during setup',
		async () => {
			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `pause-test-${Date.now()}`,
			});
			await cbDb.open();

			// Pre-populate with some data
			await cbDb.applyCouchbaseOps([
				{
					type: 'save',
					collection: 'wp_options',
					docId: 'wp_options::1',
					body: {
						meta_table: 'wp_options',
						meta_pk_column: 'option_id',
						option_id: 1,
						option_name: 'siteurl',
						option_value: 'http://test.test',
					},
				},
			]);

			const transport = new CouchbaseSyncTransport(cbDb);
			transport.pause();

			// While paused, sendChanges should be a no-op
			transport.sendChanges({
				fs: [],
				sql: [
					{
						type: 'sql',
						subtype: 'replay-query',
						query: "DELETE FROM wp_options WHERE option_name = 'siteurl'",
						query_type: 'DELETE',
						table_name: 'wp_options',
						auto_increment_column: 'option_id',
						last_insert_id: 0,
					},
				],
			});

			// Wait for any async operations
			await new Promise((resolve) => setTimeout(resolve, 500));

			// The option should still exist — transport was paused
			const docs = await cbDb.getAllDocuments('wp_options');
			const siteUrl = docs.find((d) => d.body?.option_name === 'siteurl');
			expect(siteUrl).toBeDefined();
			expect(siteUrl!.body!.option_value).toBe('http://test.test');

			// After resume, changes should flow
			transport.resume();
			transport.sendChanges({
				fs: [],
				sql: [
					{
						type: 'sql',
						subtype: 'reconstruct-insert',
						query_type: 'INSERT',
						table_name: 'wp_options',
						auto_increment_column: 'option_id',
						last_insert_id: 2,
						row: {
							option_id: 2,
							option_name: 'new_option',
							option_value: 'new_value',
						},
					},
				],
			});

			await new Promise((resolve) => setTimeout(resolve, 500));
			const allDocs = await cbDb.getAllDocuments('wp_options');
			const newOpt = allDocs.find(
				(d) => d.body?.option_name === 'new_option'
			);
			expect(newOpt).toBeDefined();

			await cbDb.close();
		},
		{ timeout: 30_000 }
	);
});

describe('Regression: full save→restore→modify cycle', () => {
	it(
		'data survives: save → restore on new site → modify → check PouchDB',
		async () => {
			// STEP 1: Boot site A, create content, snapshot to PouchDB
			const siteA = await bootSite('http://cycle-a.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'Persistent Post', 'post_content' => 'Must survive', 'post_status' => 'publish', 'post_author' => 1]);
				update_option('persistent_opt', 'must_survive');
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `cycle-test-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);
			await snapshotFilesToPouchDB(siteA, cbDb);

			// Verify snapshot has our data
			const optsBefore = await cbDb.getAllDocuments('wp_options');
			const persistOpt = optsBefore.find(
				(d) => d.body?.option_name === 'persistent_opt'
			);
			expect(persistOpt).toBeDefined();

			// STEP 2: Boot site B (simulates new tab), restore from PouchDB
			const siteB = await bootSite('http://cycle-b.test/');
			await installSqlSyncMuPlugin(siteB);
			await restoreFromCouchbase(siteB, cbDb);

			// Verify restored data exists
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
			expect(titles).toContain('Persistent Post');

			// STEP 3: Simulate plugin deactivation on site B
			// (generates UPDATE on wp_options)
			const journalB: SQLJournalEntry[] = [];
			await journalSQLQueries(siteB, (e) => journalB.push(e));

			await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('active_plugins', serialize([]));
				update_option('recently_activated', serialize(['hello.php' => time()]));
			`,
			});

			// STEP 4: Push the UPDATE changes to PouchDB
			// (this is what the transport does)
			const writeEntries = journalB.filter(
				(e) => e.query_type !== 'SELECT' && e.table_name !== ''
			);
			for (const entry of writeEntries) {
				const ops = sqlJournalEntryToCouchbaseOps(entry);
				await cbDb.applyCouchbaseOps(ops);
			}

			// STEP 5: Verify PouchDB still has the original data
			// (the plugin deactivation should NOT destroy other data)
			const optsAfter = await cbDb.getAllDocuments('wp_options');
			const persistOptAfter = optsAfter.find(
				(d) => d.body?.option_name === 'persistent_opt'
			);
			expect(persistOptAfter).toBeDefined();
			expect(persistOptAfter!.body!.option_value).toBe('must_survive');

			const postsAfter = await cbDb.getAllDocuments('wp_posts');
			const persistPost = postsAfter.find(
				(d) => d.body?.post_title === 'Persistent Post'
			);
			expect(persistPost).toBeDefined();

			// STEP 6: Restore on yet another site (simulates tab 3)
			const siteC = await bootSite('http://cycle-c.test/');
			await installSqlSyncMuPlugin(siteC);
			await restoreFromCouchbase(siteC, cbDb);

			const finalResult = await siteC.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				echo json_encode([
					'post' => !empty(get_posts(['post_status' => 'publish', 'numberposts' => -1, 's' => 'Persistent Post'])),
					'option' => get_option('persistent_opt', 'MISSING'),
				]);
			`,
			});
			const final = JSON.parse(
				new TextDecoder().decode(finalResult.bytes)
			);
			expect(final.post).toBe(true);
			expect(final.option).toBe('must_survive');

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});

describe('Regression: UPDATE with complex WHERE clauses', () => {
	it('extracts docId from WHERE option_name = X', () => {
		const entry: SQLJournalEntry = {
			type: 'sql',
			subtype: 'replay-query',
			query: "UPDATE `wp_options` SET `option_value` = 'a:0:{}' WHERE `option_name` = 'active_plugins'",
			query_type: 'UPDATE',
			table_name: 'wp_options',
			auto_increment_column: 'option_id',
			last_insert_id: 0,
		};

		const ops = sqlJournalEntryToCouchbaseOps(entry);
		expect(ops).toHaveLength(1);
		const op = ops[0];
		expect(op.type).toBe('update');
		// Should extract option_name as fallback key
		if (op.type === 'update') {
			expect(op.docId).not.toBeNull();
			expect(op.docId).toContain('active_plugins');
		}
	});

	it('extracts docId from DELETE WHERE option_name = X', () => {
		const entry: SQLJournalEntry = {
			type: 'sql',
			subtype: 'replay-query',
			query: "DELETE FROM `wp_options` WHERE `option_name` = '_transient_timeout_foo'",
			query_type: 'DELETE',
			table_name: 'wp_options',
			auto_increment_column: 'option_id',
			last_insert_id: 0,
		};

		const ops = sqlJournalEntryToCouchbaseOps(entry);
		expect(ops).toHaveLength(1);
		if (ops[0].type === 'delete') {
			expect(ops[0].docId).not.toBeNull();
			expect(ops[0].docId).toContain('_transient_timeout_foo');
		}
	});

	it('extracts docId from WHERE with backtick-quoted columns', () => {
		const entry: SQLJournalEntry = {
			type: 'sql',
			subtype: 'replay-query',
			query: "UPDATE `wp_postmeta` SET `meta_value` = 'new' WHERE `meta_key` = '_edit_lock' AND `post_id` = 42",
			query_type: 'UPDATE',
			table_name: 'wp_postmeta',
			auto_increment_column: 'meta_id',
			last_insert_id: 0,
		};

		const ops = sqlJournalEntryToCouchbaseOps(entry);
		expect(ops).toHaveLength(1);
		if (ops[0].type === 'update') {
			// Should extract meta_key=_edit_lock as fallback
			expect(ops[0].docId).not.toBeNull();
		}
	});
});

describe('Regression: setup then modify preserves PouchDB state', () => {
	it(
		'overrideAutoincrementSequences after restore does not corrupt PouchDB',
		async () => {
			// Simulate the exact production flow:
			// 1. Open PouchDB with saved data
			// 2. Restore from PouchDB
			// 3. Run setupPlaygroundSync (installs mu-plugin, overrides autoincrement)
			// 4. Verify PouchDB data is not corrupted

			const siteA = await bootSite('http://no-corrupt-a.test/');
			await installSqlSyncMuPlugin(siteA);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'Survive Setup', 'post_status' => 'publish', 'post_author' => 1]);
			`,
			});

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `no-corrupt-${Date.now()}`,
			});
			await cbDb.open();
			await snapshotSqlToPouchDB(siteA, cbDb);

			const postsBefore = await cbDb.getAllDocuments('wp_posts');
			const survivePost = postsBefore.find(
				(d) => d.body?.post_title === 'Survive Setup'
			);
			expect(survivePost).toBeDefined();

			// Now simulate what happens on boot:
			// Restore, then setup sync pipeline with transport PAUSED
			const siteB = await bootSite('http://no-corrupt-b.test/');
			await installSqlSyncMuPlugin(siteB);
			await restoreFromCouchbase(siteB, cbDb);

			// Create a paused transport (as setup-couchbase-sync now does)
			const transport = new CouchbaseSyncTransport(cbDb);
			transport.pause();

			// Run the setup operations that USED to corrupt PouchDB
			await overrideAutoincrementSequences(siteB, 1000000);

			// Journal some setup-related queries while paused
			const setupEntries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteB, (e) => setupEntries.push(e));

			// Trigger a PHP request to generate setup artifacts
			await siteB.run({
				code: `<?php require '/wordpress/wp-load.php'; echo 'ok';`,
			});

			// Send whatever the journal captured through the paused transport
			const writeEntries = setupEntries.filter(
				(e) => e.query_type !== 'SELECT' && e.table_name !== ''
			);
			if (writeEntries.length > 0) {
				transport.sendChanges({
					fs: [],
					sql: writeEntries,
				});
			}

			await new Promise((resolve) => setTimeout(resolve, 500));

			// Resume transport
			transport.resume();

			// Verify PouchDB data is NOT corrupted
			const postsAfter = await cbDb.getAllDocuments('wp_posts');
			const survivePostAfter = postsAfter.find(
				(d) => d.body?.post_title === 'Survive Setup'
			);
			expect(survivePostAfter).toBeDefined();

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});
