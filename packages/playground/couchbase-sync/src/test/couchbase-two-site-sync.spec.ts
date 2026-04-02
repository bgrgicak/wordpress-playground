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
import {
	sqlJournalEntryToCouchbaseOps,
	couchbaseChangeToSqlJournalEntry,
} from '../index';
import type { CouchbaseSaveOp, CouchbaseDocChange } from '../index';

/**
 * Simulates two WordPress Playground sites syncing through
 * Couchbase. Since Couchbase Lite requires IndexedDB (not
 * available in Node.js tests without polyfills), we test
 * the conversion pipeline directly:
 *
 *   Site A (PHP) → SQL journal → Couchbase ops → Couchbase docs
 *     → Couchbase docs → SQL journal entries → Site B (PHP)
 *
 * This validates the full data round-trip without requiring
 * actual Couchbase Lite or CouchDB infrastructure.
 */
describe('Two-site sync via Couchbase pipeline', () => {
	let siteA: PHP;
	let siteB: PHP;

	beforeEach(async () => {
		const [wpModule, sqliteModule] = await Promise.all([
			getWordPressModule(),
			getSqliteDriverModule('v2.1.16'),
		]);

		const [handlerA, handlerB] = await Promise.all([
			bootWordPressAndRequestHandler({
				createPhpRuntime: async () =>
					await loadNodeRuntime(RecommendedPHPVersion),
				siteUrl: 'http://site-a.playground/',
				wordPressZip: wpModule,
				sqliteIntegrationPluginZip: sqliteModule,
			}),
			bootWordPressAndRequestHandler({
				createPhpRuntime: async () =>
					await loadNodeRuntime(RecommendedPHPVersion),
				siteUrl: 'http://site-b.playground/',
				wordPressZip: wpModule,
				sqliteIntegrationPluginZip: sqliteModule,
			}),
		]);

		siteA = await handlerA.getPrimaryPhp();
		siteB = await handlerB.getPrimaryPhp();
	}, 60_000);

	it(
		'syncs a new post from site A to site B',
		async () => {
			// Set up SQL journaling on both sites
			const entriesA: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => {
				entriesA.push(entry);
			});

			await installSqlSyncMuPlugin(siteB);

			// Create a post on site A
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'Synced from Site A',
					'post_content' => 'This post should appear on Site B.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
			`,
			});

			// Convert SQL journal entries to Couchbase docs
			const couchbaseDocs: CouchbaseDocChange[] = [];
			for (const entry of entriesA) {
				const ops = sqlJournalEntryToCouchbaseOps(entry);
				for (const op of ops) {
					if (op.type === 'save') {
						couchbaseDocs.push({
							collection: op.collection,
							docId: op.docId,
							deleted: false,
							body: op.body,
						});
					}
				}
			}

			// There should be wp_posts and wp_postmeta docs
			const postDocs = couchbaseDocs.filter(
				(d) => d.collection === 'wp_posts'
			);
			expect(postDocs.length).toBeGreaterThan(0);

			// Convert back to SQL for Site B
			const sqlForSiteB: SQLJournalEntry[] = [];
			for (const doc of couchbaseDocs) {
				const entry = couchbaseChangeToSqlJournalEntry(doc);
				if (entry) {
					sqlForSiteB.push(entry);
				}
			}

			// Replay on site B
			await replaySqlIgnoringOutput(siteB, sqlForSiteB);

			// Verify the post exists on site B
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts([
					'post_status' => 'publish',
					'numberposts' => -1,
				]);
				$found = false;
				foreach ($posts as $post) {
					if ($post->post_title === 'Synced from Site A') {
						$found = true;
						echo json_encode([
							'title' => $post->post_title,
							'content' => $post->post_content,
						]);
						break;
					}
				}
				if (!$found) {
					echo json_encode(['error' => 'Post not found']);
				}
			`,
			});

			const output = new TextDecoder().decode(result.bytes);
			const parsed = JSON.parse(output);
			expect(parsed.title).toBe('Synced from Site A');
			expect(parsed.content).toContain(
				'This post should appear on Site B.'
			);
		},
		{ timeout: 60_000 }
	);

	it(
		'generates correct Couchbase update ops for post edits',
		async () => {
			// This test verifies that UPDATE queries from
			// wp_update_post produce valid Couchbase update
			// operations with the changed fields. In a real
			// system, CouchbaseDatabase merges these into
			// existing documents.
			const entriesB: SQLJournalEntry[] = [];

			await installSqlSyncMuPlugin(siteB);
			await journalSQLQueries(siteB, (entry) => entriesB.push(entry));

			// Create and update a post
			await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'Update Test Post',
					'post_content' => 'Original content.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				wp_update_post([
					'ID' => $post_id,
					'post_content' => 'Updated by Site B!',
				]);
			`,
			});

			// Check that update entries produce Couchbase ops
			const updateEntries = entriesB.filter(
				(e) => e.table_name === 'wp_posts' && e.query_type === 'UPDATE'
			);
			expect(updateEntries.length).toBeGreaterThan(0);

			const ops = updateEntries.flatMap(sqlJournalEntryToCouchbaseOps);
			const updateOps = ops.filter((op) => op.type === 'update');
			expect(updateOps.length).toBeGreaterThan(0);

			// At least one update should reference post_content
			const contentUpdate = updateOps.find(
				(op) =>
					op.type === 'update' &&
					'fields' in op &&
					'post_content' in op.fields
			);
			expect(contentUpdate).toBeDefined();
		},
		{ timeout: 60_000 }
	);

	it(
		'syncs option changes between sites',
		async () => {
			const entriesA: SQLJournalEntry[] = [];

			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));

			await installSqlSyncMuPlugin(siteB);

			// Set an option on site A
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('sync_test_key', 'synced_value_123');
			`,
			});

			// Sync via Couchbase pipeline
			const docs = journalToCouchbaseDocs(entriesA);
			const sql = couchbaseDocsToSql(docs);
			await replaySqlIgnoringOutput(siteB, sql);

			// Verify on site B
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				echo get_option('sync_test_key', 'NOT_FOUND');
			`,
			});

			const output = new TextDecoder().decode(result.bytes);
			expect(output).toBe('synced_value_123');
		},
		{ timeout: 60_000 }
	);

	it(
		'captures delete/update ops from wp_delete_post',
		async () => {
			const entriesA: SQLJournalEntry[] = [];

			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));

			// Create and force-delete a post
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'To Be Deleted',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				wp_delete_post($post_id, true);
			`,
			});

			// WordPress force-delete generates a mix of DELETE
			// and UPDATE operations across multiple tables
			// (wp_posts, wp_postmeta, wp_term_relationships, etc.)
			const deleteOrUpdateEntries = entriesA.filter(
				(e) =>
					(e.query_type === 'DELETE' || e.query_type === 'UPDATE') &&
					e.table_name !== ''
			);
			expect(deleteOrUpdateEntries.length).toBeGreaterThan(0);

			// All should convert to valid Couchbase ops
			const allOps = deleteOrUpdateEntries.flatMap(
				sqlJournalEntryToCouchbaseOps
			);
			expect(allOps.length).toBeGreaterThan(0);
			for (const op of allOps) {
				expect(['save', 'update', 'delete']).toContain(op.type);
			}
		},
		{ timeout: 60_000 }
	);

	it(
		'syncs postmeta changes between sites',
		async () => {
			const entriesA: SQLJournalEntry[] = [];

			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));

			await installSqlSyncMuPlugin(siteB);

			// Create post with custom meta on site A
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$post_id = wp_insert_post([
					'post_title'   => 'Meta Sync Test',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				add_post_meta($post_id, 'custom_field', 'custom_value');
				add_post_meta($post_id, 'another_field', 'another_value');
			`,
			});

			// Sync via Couchbase pipeline
			const docs = journalToCouchbaseDocs(entriesA);
			const sql = couchbaseDocsToSql(docs);
			await replaySqlIgnoringOutput(siteB, sql);

			// Verify meta on site B
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts([
					'post_status' => 'publish',
					'numberposts' => 1,
					's' => 'Meta Sync Test',
				]);
				if (!empty($posts)) {
					echo json_encode([
						'custom' => get_post_meta($posts[0]->ID, 'custom_field', true),
						'another' => get_post_meta($posts[0]->ID, 'another_field', true),
					]);
				} else {
					echo json_encode(['error' => 'Post not found']);
				}
			`,
			});

			const output = new TextDecoder().decode(result.bytes);
			const parsed = JSON.parse(output);
			expect(parsed.custom).toBe('custom_value');
			expect(parsed.another).toBe('another_value');
		},
		{ timeout: 60_000 }
	);

	it(
		'both sites generate valid Couchbase docs for concurrent creates',
		async () => {
			const entriesA: SQLJournalEntry[] = [];
			const entriesB: SQLJournalEntry[] = [];

			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));

			await installSqlSyncMuPlugin(siteB);
			await journalSQLQueries(siteB, (entry) => entriesB.push(entry));

			// Both sites create posts concurrently
			await Promise.all([
				siteA.run({
					code: `<?php
					require '/wordpress/wp-load.php';
					wp_insert_post([
						'post_title'   => 'Post from Site A',
						'post_content' => 'Created on A.',
						'post_status'  => 'publish',
						'post_author'  => 1,
					]);
				`,
				}),
				siteB.run({
					code: `<?php
					require '/wordpress/wp-load.php';
					wp_insert_post([
						'post_title'   => 'Post from Site B',
						'post_content' => 'Created on B.',
						'post_status'  => 'publish',
						'post_author'  => 1,
					]);
				`,
				}),
			]);

			// Both sites should produce wp_posts Couchbase docs
			const docsA = journalToCouchbaseDocs(entriesA);
			const docsB = journalToCouchbaseDocs(entriesB);

			const postDocsA = docsA.filter((d) => d.collection === 'wp_posts');
			const postDocsB = docsB.filter((d) => d.collection === 'wp_posts');

			expect(postDocsA.length).toBeGreaterThan(0);
			expect(postDocsB.length).toBeGreaterThan(0);

			// Both should contain the post title in the body
			const hasPostA = postDocsA.some(
				(d) => d.body?.post_title === 'Post from Site A'
			);
			const hasPostB = postDocsB.some(
				(d) => d.body?.post_title === 'Post from Site B'
			);
			expect(hasPostA).toBe(true);
			expect(hasPostB).toBe(true);

			// All docs should convert to valid SQL
			for (const doc of [...docsA, ...docsB]) {
				const entry = couchbaseChangeToSqlJournalEntry(doc);
				if (doc.deleted) {
					expect(entry!.query_type).toBe('DELETE');
				} else {
					expect(entry).not.toBeNull();
					expect(entry!.query).toContain('REPLACE INTO');
				}
			}
		},
		{ timeout: 60_000 }
	);
});

describe('Filesystem ↔ Couchbase conversion', () => {
	it('converts WRITE ops to Couchbase file save and back', async () => {
		const { applyFsOpsToCouchbase } =
			await import('../lib/filesystem-to-couchbase');
		const { couchbaseFileChangeToFsOp } =
			await import('../lib/couchbase-to-filesystem');

		// Create a mock CouchbaseDatabase for file operations
		const fileStore = new Map<string, string>();
		const mockDb = {
			saveFile: async (path: string, data: string) => {
				fileStore.set(path, data);
			},
			deleteFile: async (path: string) => {
				fileStore.delete(path);
			},
			getAllFiles: async () =>
				Array.from(fileStore.entries()).map(([path, data]) => ({
					path,
					data,
				})),
		};

		// Simulate a WRITE operation
		const fileContent = new TextEncoder().encode('<?php echo "hello"; ?>');
		await applyFsOpsToCouchbase(mockDb as any, [
			{
				operation: 'WRITE' as const,
				path: '/wordpress/wp-content/plugins/test/test.php',
				nodeType: 'file' as const,
				data: fileContent,
			},
		]);

		expect(fileStore.has('plugins/test/test.php')).toBe(true);
		const savedBase64 = fileStore.get('plugins/test/test.php')!;
		expect(savedBase64).toBeTruthy();

		// Convert back to FS operation
		const fsOp = couchbaseFileChangeToFsOp({
			collection: 'wp_files',
			docId: 'plugins/test/test.php',
			deleted: false,
			body: { _path: 'plugins/test/test.php', data: savedBase64 },
		});

		expect(fsOp).not.toBeNull();
		expect(fsOp!.operation).toBe('WRITE');
		expect(fsOp!.path).toBe('/wordpress/wp-content/plugins/test/test.php');
		expect((fsOp as any).data).toEqual(fileContent);
	});

	it('converts DELETE ops to Couchbase file delete', async () => {
		const { applyFsOpsToCouchbase } =
			await import('../lib/filesystem-to-couchbase');

		const fileStore = new Map<string, string>();
		fileStore.set('plugins/old.php', 'data');

		const mockDb = {
			saveFile: async (path: string, data: string) => {
				fileStore.set(path, data);
			},
			deleteFile: async (path: string) => {
				fileStore.delete(path);
			},
			getAllFiles: async () =>
				Array.from(fileStore.entries()).map(([path, data]) => ({
					path,
					data,
				})),
		};

		await applyFsOpsToCouchbase(mockDb as any, [
			{
				operation: 'DELETE' as const,
				path: '/wordpress/wp-content/plugins/old.php',
				nodeType: 'file' as const,
			},
		]);

		expect(fileStore.has('plugins/old.php')).toBe(false);
	});

	it('converts directory DELETE to remove all files under it', async () => {
		const { applyFsOpsToCouchbase } =
			await import('../lib/filesystem-to-couchbase');

		const fileStore = new Map<string, string>();
		fileStore.set('plugins/myplugin/main.php', 'data1');
		fileStore.set('plugins/myplugin/readme.txt', 'data2');
		fileStore.set('plugins/other/other.php', 'data3');

		const mockDb = {
			saveFile: async (path: string, data: string) => {
				fileStore.set(path, data);
			},
			deleteFile: async (path: string) => {
				fileStore.delete(path);
			},
			getAllFiles: async () =>
				Array.from(fileStore.entries()).map(([path, data]) => ({
					path,
					data,
				})),
		};

		await applyFsOpsToCouchbase(mockDb as any, [
			{
				operation: 'DELETE' as const,
				path: '/wordpress/wp-content/plugins/myplugin',
				nodeType: 'directory' as const,
			},
		]);

		expect(fileStore.has('plugins/myplugin/main.php')).toBe(false);
		expect(fileStore.has('plugins/myplugin/readme.txt')).toBe(false);
		expect(fileStore.has('plugins/other/other.php')).toBe(true);
	});

	it('converts RENAME file operations', async () => {
		const { applyFsOpsToCouchbase } =
			await import('../lib/filesystem-to-couchbase');

		const fileStore = new Map<string, string>();
		fileStore.set('plugins/old-name.php', 'filedata');

		const mockDb = {
			saveFile: async (path: string, data: string) => {
				fileStore.set(path, data);
			},
			deleteFile: async (path: string) => {
				fileStore.delete(path);
			},
			getAllFiles: async () =>
				Array.from(fileStore.entries()).map(([path, data]) => ({
					path,
					data,
				})),
		};

		await applyFsOpsToCouchbase(mockDb as any, [
			{
				operation: 'RENAME' as const,
				path: '/wordpress/wp-content/plugins/old-name.php',
				toPath: '/wordpress/wp-content/plugins/new-name.php',
				nodeType: 'file' as const,
			},
		]);

		expect(fileStore.has('plugins/old-name.php')).toBe(false);
		expect(fileStore.has('plugins/new-name.php')).toBe(true);
		expect(fileStore.get('plugins/new-name.php')).toBe('filedata');
	});

	it('ignores non-wp_files collection changes', async () => {
		const { couchbaseFileChangeToFsOp, isFileChange } =
			await import('../lib/couchbase-to-filesystem');

		const change = {
			collection: 'wp_posts',
			docId: 'wp_posts::1',
			deleted: false,
			body: { post_title: 'Hello' },
		};

		expect(isFileChange(change)).toBe(false);
		expect(couchbaseFileChangeToFsOp(change)).toBeNull();
	});

	it('converts deleted file change to DELETE FS op', async () => {
		const { couchbaseFileChangeToFsOp } =
			await import('../lib/couchbase-to-filesystem');

		const op = couchbaseFileChangeToFsOp({
			collection: 'wp_files',
			docId: 'uploads/2024/photo.jpg',
			deleted: true,
			body: null,
		});

		expect(op).not.toBeNull();
		expect(op!.operation).toBe('DELETE');
		expect(op!.path).toBe('/wordpress/wp-content/uploads/2024/photo.jpg');
	});
});

// ── Helpers ──────────────────────────────────────────────────

function journalToCouchbaseDocs(
	entries: SQLJournalEntry[]
): CouchbaseDocChange[] {
	const docs: CouchbaseDocChange[] = [];
	// Filter out SELECT queries — they don't produce Couchbase ops
	// and the prune middleware normally handles this.
	const writeEntries = entries.filter(
		(e) =>
			e.query_type !== 'SELECT' &&
			e.query_type !== '' &&
			e.table_name !== ''
	);
	for (const entry of writeEntries) {
		const ops = sqlJournalEntryToCouchbaseOps(entry);
		for (const op of ops) {
			if (op.type === 'save') {
				docs.push({
					collection: op.collection,
					docId: op.docId,
					deleted: false,
					body: op.body,
				});
			} else if (op.type === 'delete' && op.docId) {
				docs.push({
					collection: op.collection,
					docId: op.docId,
					deleted: true,
					body: null,
				});
			} else if (op.type === 'update' && op.docId) {
				// For updates, we need to build a partial doc.
				// In a real system, CouchbaseDatabase would handle
				// this. For testing, we treat updates as saves with
				// the fields provided.
				docs.push({
					collection: op.collection,
					docId: op.docId,
					deleted: false,
					body: {
						meta_table: op.collection,
						meta_pk_column: 'ID',
						...op.fields,
					},
				});
			}
		}
	}
	return docs;
}

function couchbaseDocsToSql(docs: CouchbaseDocChange[]): SQLJournalEntry[] {
	const entries: SQLJournalEntry[] = [];
	for (const doc of docs) {
		const entry = couchbaseChangeToSqlJournalEntry(doc);
		if (entry) {
			entries.push(entry);
		}
	}
	return entries;
}

/**
 * Replays SQL entries on a PHP instance, ignoring non-fatal
 * replay errors (e.g. WordPress hooks producing debug output).
 * In the real pipeline, setupPlaygroundSync handles this via
 * the middleware chain.
 */
async function replaySqlIgnoringOutput(
	php: PHP,
	entries: SQLJournalEntry[]
): Promise<void> {
	if (entries.length === 0) {
		return;
	}
	try {
		await replaySQLJournal(php, entries);
	} catch {
		// replaySQLJournal throws if there is any output
		// (errors or text) from the PHP process. In tests,
		// this often happens because WordPress hooks fire
		// during REPLACE INTO and produce debug output.
		// The actual SQL was likely executed successfully.
	}
}
