/**
 * Tests for the incremental snapshot feature, which avoids
 * full-scanning every table on every sync cycle by comparing
 * lightweight metadata (COUNT + MAX(pk)) first.
 */
import type { PHP } from '@php-wasm/universal';
import { installSqlSyncMuPlugin } from '@wp-playground/sync';
import {
	getSqliteDriverModule,
	getWordPressModule,
} from '@wp-playground/wordpress-builds';
import { RecommendedPHPVersion } from '@wp-playground/common';
import { bootWordPressAndRequestHandler } from '@wp-playground/wordpress';
import { loadNodeRuntime } from '@php-wasm/node';
import { CouchbaseDatabase } from '../lib/couchbase-database';
import {
	snapshotSqlToPouchDB,
	incrementalSnapshotSqlToPouchDB,
} from '../lib/snapshot-to-pouchdb';

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

describe('Incremental snapshot', () => {
	it(
		'reports 0 tables scanned when nothing changed since initial snapshot',
		async () => {
			const site = await bootSite('http://incr-noop.test/');
			await installSqlSyncMuPlugin(site);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `incr-noop-${Date.now()}`,
			});
			await cbDb.open();

			// Initial full snapshot to populate PouchDB and
			// prime the metadata cache.
			const fullCount = await snapshotSqlToPouchDB(site, cbDb);
			expect(fullCount).toBeGreaterThan(0);

			// First incremental call seeds the metadata cache
			// (no previous metadata exists yet).
			const first = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			// The first incremental call has no cached metadata,
			// so it scans all tables. That is expected.

			// Second incremental call: nothing changed, so no
			// tables should need scanning.
			const second = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			expect(second.tablesScanned).toBe(0);
			expect(second.rowsWritten).toBe(0);

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);

	it(
		'detects a new post and scans the changed table',
		async () => {
			const site = await bootSite('http://incr-insert.test/');
			await installSqlSyncMuPlugin(site);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `incr-insert-${Date.now()}`,
			});
			await cbDb.open();

			// Full snapshot + two incremental calls to prime
			// and then stabilize the metadata cache.
			await snapshotSqlToPouchDB(site, cbDb);
			await incrementalSnapshotSqlToPouchDB(site, cbDb);
			const baseline = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			expect(baseline.tablesScanned).toBe(0);

			// Insert a new post via PHP
			await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'  => 'Incremental Test Post',
					'post_status' => 'publish',
					'post_author' => 1,
				]);
				`,
			});

			// Incremental snapshot should detect the change
			const result = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			expect(result.tablesScanned).toBeGreaterThan(0);
			expect(result.rowsWritten).toBeGreaterThan(0);

			// Verify the new post is in PouchDB
			const postDocs = await cbDb.getAllDocuments('wp_posts');
			const titles = postDocs.map((d) => d.body?.post_title);
			expect(titles).toContain('Incremental Test Post');

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);

	it(
		'misses in-place UPDATEs but forceFullSweep catches them',
		async () => {
			const site = await bootSite('http://incr-update.test/');
			await installSqlSyncMuPlugin(site);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `incr-update-${Date.now()}`,
			});
			await cbDb.open();

			// Full snapshot + stabilize
			await snapshotSqlToPouchDB(site, cbDb);
			await incrementalSnapshotSqlToPouchDB(site, cbDb);
			await incrementalSnapshotSqlToPouchDB(site, cbDb);

			// Capture the original blogname value
			const optDocsBefore = await cbDb.getAllDocuments('wp_options');
			const blogNameBefore = optDocsBefore.find(
				(d) => d.body?.option_name === 'blogname'
			);
			expect(blogNameBefore).toBeDefined();
			const originalName = blogNameBefore!.body!.option_value;

			// Update an option in-place (count and max_pk stay
			// the same, so the fast check won't detect it)
			await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('blogname', 'Updated Blog Title');
				`,
			});

			// Normal incremental should see 0 tables scanned
			// because count and max_pk didn't change.
			const normal = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			expect(normal.tablesScanned).toBe(0);

			// The old value should still be in PouchDB
			const optDocsMiddle = await cbDb.getAllDocuments('wp_options');
			const blogNameMiddle = optDocsMiddle.find(
				(d) => d.body?.option_name === 'blogname'
			);
			expect(blogNameMiddle!.body!.option_value).toBe(originalName);

			// Force full sweep should catch the update
			const forced = await incrementalSnapshotSqlToPouchDB(
				site,
				cbDb,
				true
			);
			expect(forced.tablesScanned).toBeGreaterThan(0);
			expect(forced.rowsWritten).toBeGreaterThan(0);

			// Now the updated value should be in PouchDB
			const optDocsAfter = await cbDb.getAllDocuments('wp_options');
			const blogNameAfter = optDocsAfter.find(
				(d) => d.body?.option_name === 'blogname'
			);
			expect(blogNameAfter!.body!.option_value).toBe(
				'Updated Blog Title'
			);

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);

	it(
		'detects deleted rows and removes them from PouchDB',
		async () => {
			const site = await bootSite('http://incr-delete.test/');
			await installSqlSyncMuPlugin(site);

			const cbDb = new CouchbaseDatabase({
				adapter: 'memory',
				name: `incr-delete-${Date.now()}`,
			});
			await cbDb.open();

			// Create a post we can later delete
			await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'  => 'Post To Delete',
					'post_status' => 'publish',
					'post_author' => 1,
				]);
				`,
			});

			// Full snapshot + stabilize
			await snapshotSqlToPouchDB(site, cbDb);
			await incrementalSnapshotSqlToPouchDB(site, cbDb);
			await incrementalSnapshotSqlToPouchDB(site, cbDb);

			// Confirm the post is in PouchDB
			const postsBefore = await cbDb.getAllDocuments('wp_posts');
			const toDelete = postsBefore.find(
				(d) => d.body?.post_title === 'Post To Delete'
			);
			expect(toDelete).toBeDefined();

			// Delete the post via PHP (force delete, skip trash)
			await site.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				global $wpdb;
				$pdo = $GLOBALS['@pdo'];
				// Find and hard-delete the post
				$post_id = $wpdb->get_var(
					"SELECT ID FROM wp_posts WHERE post_title = 'Post To Delete'"
				);
				if ($post_id) {
					$pdo->exec("DELETE FROM wp_posts WHERE ID = $post_id");
					$pdo->exec("DELETE FROM wp_postmeta WHERE post_id = $post_id");
				}
				`,
			});

			// Incremental should detect the count decrease and
			// remove the deleted row.
			const result = await incrementalSnapshotSqlToPouchDB(site, cbDb);
			expect(result.tablesScanned).toBeGreaterThan(0);

			// The deleted post should no longer be in PouchDB
			const postsAfter = await cbDb.getAllDocuments('wp_posts');
			const deleted = postsAfter.find(
				(d) => d.body?.post_title === 'Post To Delete'
			);
			expect(deleted).toBeUndefined();

			await cbDb.close();
		},
		{ timeout: 120_000 }
	);
});
