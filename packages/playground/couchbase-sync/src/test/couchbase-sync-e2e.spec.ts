import type { PHP } from '@php-wasm/universal';
import type { SQLJournalEntry } from '@wp-playground/sync';
import { installSqlSyncMuPlugin, journalSQLQueries } from '@wp-playground/sync';
import {
	getSqliteDriverModule,
	getWordPressModule,
} from '@wp-playground/wordpress-builds';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { bootWordPressAndRequestHandler } from '@wp-playground/wordpress';
import { loadNodeRuntime } from '@php-wasm/node';
import {
	sqlJournalEntryToCouchbaseOps,
	couchbaseChangeToSqlJournalEntry,
} from '../index';
import type { CouchbaseSaveOp, CouchbaseDocChange } from '../index';

describe('Couchbase Sync E2E - SQLite round-trip', () => {
	let php: PHP;

	beforeEach(async () => {
		const handler = await bootWordPressAndRequestHandler({
			createPhpRuntime: async () =>
				await loadNodeRuntime(RecommendedPHPVersion),
			siteUrl: 'http://playground-domain/',
			wordPressZip: await getWordPressModule(),
			sqliteIntegrationPluginZip: await getSqliteDriverModule('v2.1.16'),
		});
		php = await handler.getPrimaryPhp();
	});

	it(
		'captures wp_insert_post and converts to Couchbase save op',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'Couchbase Test Post',
					'post_content' => 'This is synced to Couchbase.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
			`,
			});

			// Find the wp_posts INSERT
			const postInsert = entries.find(
				(e) => e.query_type === 'INSERT' && e.table_name === 'wp_posts'
			);
			expect(postInsert).toBeDefined();

			// Convert to Couchbase ops
			const ops = sqlJournalEntryToCouchbaseOps(postInsert!);
			expect(ops).toHaveLength(1);

			const saveOp = ops[0] as CouchbaseSaveOp;
			expect(saveOp.type).toBe('save');
			expect(saveOp.collection).toBe('wp_posts');
			expect(saveOp.docId).toMatch(/^wp_posts::\d+$/);
			expect(saveOp.body.meta_table).toBe('wp_posts');

			// The body should contain the post data
			if (postInsert!.subtype === 'reconstruct-insert') {
				expect(saveOp.body.post_title).toBe('Couchbase Test Post');
				expect(saveOp.body.post_content).toBe(
					'This is synced to Couchbase.'
				);
				expect(saveOp.body.post_status).toBe('publish');
			}
		},
		{ timeout: 30_000 }
	);

	it(
		'round-trips a post: SQL → Couchbase doc → SQL',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'Round Trip Post',
					'post_content' => '<p>Hello from Couchbase</p>',
					'post_status'  => 'draft',
					'post_author'  => 1,
				]);
			`,
			});

			// Get the wp_posts insert
			const postInsert = entries.find(
				(e) => e.query_type === 'INSERT' && e.table_name === 'wp_posts'
			);
			expect(postInsert).toBeDefined();

			// SQL → Couchbase
			const ops = sqlJournalEntryToCouchbaseOps(postInsert!);
			const saveOp = ops[0] as CouchbaseSaveOp;

			// Simulate Couchbase → SQL (as if received from replicator)
			const couchbaseChange: CouchbaseDocChange = {
				collection: saveOp.collection,
				docId: saveOp.docId,
				deleted: false,
				body: saveOp.body,
			};

			const roundTrippedEntry =
				couchbaseChangeToSqlJournalEntry(couchbaseChange);
			expect(roundTrippedEntry).not.toBeNull();
			expect(roundTrippedEntry!.query_type).toBe('INSERT');
			expect(roundTrippedEntry!.table_name).toBe('wp_posts');
			expect(roundTrippedEntry!.query).toContain('REPLACE INTO');

			// The round-tripped SQL should contain the original data
			if (postInsert!.subtype === 'reconstruct-insert') {
				expect(roundTrippedEntry!.query).toContain('Round Trip Post');
				expect(roundTrippedEntry!.query).toContain(
					'<p>Hello from Couchbase</p>'
				);
			}
		},
		{ timeout: 30_000 }
	);

	it(
		'captures wp_update_post and converts to Couchbase update op',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'Original Title',
					'post_content' => 'Original content.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				wp_update_post([
					'ID'           => $post_id,
					'post_title'   => 'Updated Title',
				]);
			`,
			});

			// Find UPDATE entries for wp_posts
			const updateEntries = entries.filter(
				(e) => e.query_type === 'UPDATE' && e.table_name === 'wp_posts'
			);
			// WordPress may emit multiple UPDATE queries
			expect(updateEntries.length).toBeGreaterThan(0);

			// Convert at least one update to Couchbase ops
			const ops = sqlJournalEntryToCouchbaseOps(
				updateEntries[updateEntries.length - 1]
			);
			expect(ops).toHaveLength(1);
			expect(ops[0].type).toBe('update');
		},
		{ timeout: 30_000 }
	);

	it(
		'captures wp_delete_post and converts to Couchbase ops',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'To Be Deleted',
					'post_content' => 'This will be removed.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				wp_delete_post($post_id, true);
			`,
			});

			// WordPress force-delete may use DELETE for postmeta
			// and related tables, but for posts it often does
			// a soft delete (UPDATE) first. Look for any DELETE
			// or UPDATE entries related to the deletion.
			const deleteOrUpdateEntries = entries.filter(
				(e) =>
					(e.query_type === 'DELETE' || e.query_type === 'UPDATE') &&
					e.table_name === 'wp_posts'
			);
			expect(deleteOrUpdateEntries.length).toBeGreaterThan(0);

			// All should convert to Couchbase ops without errors
			for (const entry of deleteOrUpdateEntries) {
				const ops = sqlJournalEntryToCouchbaseOps(entry);
				expect(ops.length).toBeGreaterThan(0);
				expect(['delete', 'update']).toContain(ops[0].type);
			}
		},
		{ timeout: 30_000 }
	);

	it(
		'converts option changes to Couchbase ops',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('couchbase_test_option', 'hello-couchbase');
			`,
			});

			// Find wp_options entries (INSERT or UPDATE)
			const optionEntries = entries.filter(
				(e) => e.table_name === 'wp_options'
			);
			expect(optionEntries.length).toBeGreaterThan(0);

			// Convert all to Couchbase ops
			const allOps = optionEntries.flatMap(sqlJournalEntryToCouchbaseOps);
			expect(allOps.length).toBeGreaterThan(0);

			// Each op should reference wp_options collection
			for (const op of allOps) {
				expect(op.collection).toBe('wp_options');
			}
		},
		{ timeout: 30_000 }
	);

	it(
		'handles postmeta round-trip correctly',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'Meta Test Post',
					'post_content' => 'Testing postmeta sync.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				add_post_meta($post_id, 'couchbase_key', 'couchbase_value');
			`,
			});

			// Find wp_postmeta INSERT for our custom meta key.
			// WordPress also inserts internal meta like _pingme,
			// so filter for our specific key.
			const metaInserts = entries.filter(
				(e) =>
					e.query_type === 'INSERT' && e.table_name === 'wp_postmeta'
			);
			expect(metaInserts.length).toBeGreaterThan(0);

			// Find the one with our custom key
			const ourMeta = metaInserts.find((e) => {
				if (e.subtype === 'reconstruct-insert') {
					return e.row.meta_key === 'couchbase_key';
				}
				return false;
			});
			expect(ourMeta).toBeDefined();

			// SQL → Couchbase
			const ops = sqlJournalEntryToCouchbaseOps(ourMeta!);
			expect(ops).toHaveLength(1);
			const saveOp = ops[0] as CouchbaseSaveOp;
			expect(saveOp.collection).toBe('wp_postmeta');
			expect(saveOp.body.meta_key).toBe('couchbase_key');
			expect(saveOp.body.meta_value).toBe('couchbase_value');

			// Couchbase → SQL round-trip
			const couchbaseChange: CouchbaseDocChange = {
				collection: saveOp.collection,
				docId: saveOp.docId,
				deleted: false,
				body: saveOp.body,
			};
			const roundTripped =
				couchbaseChangeToSqlJournalEntry(couchbaseChange);
			expect(roundTripped).not.toBeNull();
			expect(roundTripped!.table_name).toBe('wp_postmeta');
		},
		{ timeout: 30_000 }
	);

	it(
		'converts a Couchbase delete change to a valid DELETE SQL',
		async () => {
			const change: CouchbaseDocChange = {
				collection: 'wp_posts',
				docId: 'wp_posts::99',
				deleted: true,
				body: {
					meta_table: 'wp_posts',
					meta_pk_column: 'ID',
				},
			};

			const entry = couchbaseChangeToSqlJournalEntry(change);
			expect(entry).not.toBeNull();
			expect(entry!.query).toBe('DELETE FROM `wp_posts` WHERE `ID` = 99');
			expect(entry!.query_type).toBe('DELETE');
		},
		{ timeout: 30_000 }
	);

	it(
		'all journal entries from a full post lifecycle convert cleanly',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(php);
			await journalSQLQueries(php, (entry: SQLJournalEntry) => {
				entries.push(entry);
			});

			// Full lifecycle: create, update, delete
			await php.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'Lifecycle Post',
					'post_content' => 'Created.',
					'post_status'  => 'draft',
					'post_author'  => 1,
				]);
				wp_update_post([
					'ID'           => $post_id,
					'post_status'  => 'publish',
				]);
				wp_delete_post($post_id, true);
			`,
			});

			expect(entries.length).toBeGreaterThan(0);

			// Every entry should convert without throwing.
			// Entries with no table_name produce empty arrays.
			for (const entry of entries) {
				expect(() =>
					sqlJournalEntryToCouchbaseOps(entry)
				).not.toThrow();

				const ops = sqlJournalEntryToCouchbaseOps(entry);
				if (!entry.table_name) {
					expect(ops).toHaveLength(0);
					continue;
				}
				expect(ops.length).toBeGreaterThan(0);

				// Every save op should round-trip
				for (const op of ops) {
					if (op.type === 'save') {
						const change: CouchbaseDocChange = {
							collection: op.collection,
							docId: op.docId,
							deleted: false,
							body: op.body,
						};
						const roundTripped =
							couchbaseChangeToSqlJournalEntry(change);
						expect(roundTripped).not.toBeNull();
					}
				}
			}
		},
		{ timeout: 30_000 }
	);
});
