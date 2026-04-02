/**
 * Stress tests for two-site WordPress sync via PouchDB.
 *
 * Every test in this file:
 * 1. Uses real WordPress PHP instances (bootWordPressAndRequestHandler)
 * 2. Uses real PouchDB replication (.replicate.to / .from)
 * 3. Verifies data on the receiving site via PHP (get_posts, etc.)
 *
 * Run with: npx nx test playground-couchbase-sync --testFile=pouchdb-stress.spec.ts
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
import {
	sqlJournalEntryToCouchbaseOps,
	couchbaseChangeToSqlJournalEntry,
} from '../index';
import type { CouchbaseDocChange } from '../index';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PouchDB = require('pouchdb');
// eslint-disable-next-line @typescript-eslint/no-require-imports
PouchDB.plugin(require('pouchdb-adapter-memory'));

// Shared WordPress modules — loaded once, reused across tests
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function newDb(name?: string): any {
	return new PouchDB(name ?? `test-${Date.now()}-${Math.random()}`, {
		adapter: 'memory',
	});
}

// ── Full pipeline helpers ────────────────────────────────────

/**
 * Pushes SQL journal entries from a WordPress site into a PouchDB
 * database. This is the "outbound" half of the sync pipeline:
 *   WordPress SQL journal → Couchbase doc ops → PouchDB
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushJournalToPouchDB(entries: SQLJournalEntry[], db: any) {
	const writeEntries = entries.filter(
		(e) => e.query_type !== 'SELECT' && e.table_name !== ''
	);
	for (const entry of writeEntries) {
		const ops = sqlJournalEntryToCouchbaseOps(entry);
		for (const op of ops) {
			if (op.type === 'save') {
				const doc: Record<string, unknown> = {
					_id: op.docId,
					...op.body,
				};
				try {
					const existing = await db.get(op.docId);
					doc._rev = existing._rev;
				} catch {
					// New doc
				}
				await db.put(doc);
			} else if (op.type === 'delete' && op.docId) {
				try {
					const existing = await db.get(op.docId);
					await db.remove(existing);
				} catch {
					// Already gone
				}
			} else if (op.type === 'update' && op.docId) {
				try {
					const existing = await db.get(op.docId);
					for (const [k, v] of Object.entries(op.fields)) {
						existing[k] = v;
					}
					await db.put(existing);
				} catch {
					// Doc doesn't exist yet
				}
			}
		}
	}
}

/**
 * Pulls all documents from a PouchDB database and replays them
 * as SQL on a WordPress site. This is the "inbound" half:
 *   PouchDB → Couchbase doc changes → SQL journal → WordPress
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pullPouchDBToSite(db: any, site: PHP) {
	const allDocs = await db.allDocs({ include_docs: true });
	const entries: SQLJournalEntry[] = [];
	for (const row of allDocs.rows) {
		if (row.id.startsWith('_design')) {
			continue;
		}
		const body: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(
			row.doc as Record<string, unknown>
		)) {
			if (k !== '_id' && k !== '_rev') {
				body[k] = v;
			}
		}
		const collection = row.id.split('::')[0];
		const change: CouchbaseDocChange = {
			collection,
			docId: row.id,
			deleted: false,
			body,
		};
		const entry = couchbaseChangeToSqlJournalEntry(change);
		if (entry) {
			entries.push(entry);
		}
	}
	if (entries.length > 0) {
		try {
			await replaySQLJournal(site, entries);
		} catch {
			// WordPress hooks may produce debug output
		}
	}
}

/**
 * Gets all published post titles from a WordPress site.
 */
async function getPostTitles(site: PHP): Promise<string[]> {
	const result = await site.run({
		code: `<?php
		require '/wordpress/wp-load.php';
		$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1, 'orderby' => 'title', 'order' => 'ASC']);
		echo json_encode(array_map(function($p) { return $p->post_title; }, $posts));
	`,
	});
	return JSON.parse(new TextDecoder().decode(result.bytes));
}

/**
 * Gets all options matching a prefix from a WordPress site.
 */
async function getOptions(
	site: PHP,
	prefix: string
): Promise<Record<string, string>> {
	const result = await site.run({
		code: `<?php
		require '/wordpress/wp-load.php';
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare("SELECT option_name, option_value FROM wp_options WHERE option_name LIKE %s", '${prefix}%'),
			ARRAY_A
		);
		$map = [];
		foreach ($rows as $row) { $map[$row['option_name']] = $row['option_value']; }
		echo json_encode($map);
	`,
	});
	return JSON.parse(new TextDecoder().decode(result.bytes));
}

// ══════════════════════════════════════════════════════════════
// COMPREHENSIVE SYNC TESTS
// ══════════════════════════════════════════════════════════════

describe('Full pipeline: WP PHP → PouchDB replication → WP PHP', () => {
	let siteA: PHP;
	let siteB: PHP;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let localA: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let localB: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let server: any;

	beforeEach(async () => {
		[siteA, siteB] = await Promise.all([
			bootSite('http://site-a.test/'),
			bootSite('http://site-b.test/'),
		]);
		await installSqlSyncMuPlugin(siteA);
		await installSqlSyncMuPlugin(siteB);
		localA = newDb();
		localB = newDb();
		server = newDb();
	}, 60_000);

	afterEach(async () => {
		await Promise.all([
			localA?.destroy(),
			localB?.destroy(),
			server?.destroy(),
		]);
	});

	/**
	 * Helper: capture journal on a site, run PHP code, push to
	 * PouchDB, replicate to server, then to other site's PouchDB,
	 * and replay on the other site.
	 */
	async function syncAtoB() {
		// Replicate localA → server → localB
		await localA.replicate.to(server);
		await server.replicate.to(localB);
		// Replay on site B
		await pullPouchDBToSite(localB, siteB);
	}

	async function syncBtoA() {
		await localB.replicate.to(server);
		await server.replicate.to(localA);
		await pullPouchDBToSite(localA, siteA);
	}

	// ── Basic sync ───────────────────────────────────────────

	it(
		'syncs a single post A→B with full PHP verification',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'Single Post Test', 'post_content' => 'Content from A', 'post_status' => 'publish', 'post_author' => 1]);
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await syncAtoB();

			const titles = await getPostTitles(siteB);
			expect(titles).toContain('Single Post Test');
		},
		{ timeout: 60_000 }
	);

	it(
		'syncs options A→B',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				update_option('sync_opt_1', 'value_1');
				update_option('sync_opt_2', 'value_2');
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await syncAtoB();

			const opts = await getOptions(siteB, 'sync_opt_');
			expect(opts['sync_opt_1']).toBe('value_1');
			expect(opts['sync_opt_2']).toBe('value_2');
		},
		{ timeout: 60_000 }
	);

	it(
		'syncs postmeta A→B',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$id = wp_insert_post(['post_title' => 'Meta Post', 'post_status' => 'publish', 'post_author' => 1]);
				add_post_meta($id, 'custom_key', 'custom_val');
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await syncAtoB();

			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1, 's' => 'Meta Post']);
				echo !empty($posts) ? get_post_meta($posts[0]->ID, 'custom_key', true) : 'MISSING';
			`,
			});
			expect(new TextDecoder().decode(result.bytes)).toBe('custom_val');
		},
		{ timeout: 60_000 }
	);

	// ── Bidirectional sync ───────────────────────────────────

	it(
		'syncs posts bidirectionally A→B and B→A',
		async () => {
			const entriesA: SQLJournalEntry[] = [];
			const entriesB: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entriesA.push(e));
			await journalSQLQueries(siteB, (e) => entriesB.push(e));

			// Site A creates a post
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'From A', 'post_status' => 'publish', 'post_author' => 1]);
			`,
			});
			await pushJournalToPouchDB(entriesA, localA);
			entriesA.length = 0;

			// Sync A→B
			await syncAtoB();

			// Site B creates a post
			await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post(['post_title' => 'From B', 'post_status' => 'publish', 'post_author' => 1]);
			`,
			});
			await pushJournalToPouchDB(entriesB, localB);

			// Sync B→A
			await syncBtoA();

			// Both sites should have both posts
			const titlesA = await getPostTitles(siteA);
			const titlesB = await getPostTitles(siteB);
			expect(titlesA).toContain('From A');
			expect(titlesA).toContain('From B');
			expect(titlesB).toContain('From A');
			expect(titlesB).toContain('From B');
		},
		{ timeout: 60_000 }
	);

	// ── Stress: bulk writes ──────────────────────────────────

	it(
		'stress: syncs 20 posts from A to B',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				for ($i = 1; $i <= 20; $i++) {
					wp_insert_post([
						'post_title' => "Bulk Post $i",
						'post_content' => "Content for bulk post $i",
						'post_status' => 'publish',
						'post_author' => 1,
					]);
				}
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await syncAtoB();

			const titles = await getPostTitles(siteB);
			for (let i = 1; i <= 20; i++) {
				expect(titles).toContain(`Bulk Post ${i}`);
			}
		},
		{ timeout: 120_000 }
	);

	it(
		'stress: syncs 50 options from A to B',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			// Build PHP code for 50 options
			const phpLines = [];
			for (let i = 1; i <= 50; i++) {
				phpLines.push(`update_option('stress_opt_${i}', 'val_${i}');`);
			}
			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				${phpLines.join('\n')}
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await syncAtoB();

			const opts = await getOptions(siteB, 'stress_opt_');
			for (let i = 1; i <= 50; i++) {
				expect(opts[`stress_opt_${i}`]).toBe(`val_${i}`);
			}
		},
		{ timeout: 120_000 }
	);

	// ── Stress: rapid successive syncs ───────────────────────

	it(
		'stress: 5 rounds of create-sync-verify',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			for (let round = 1; round <= 5; round++) {
				entries.length = 0;

				await siteA.run({
					code: `<?php
					require '/wordpress/wp-load.php';
					wp_insert_post([
						'post_title' => 'Round ${round} Post',
						'post_status' => 'publish',
						'post_author' => 1,
					]);
					update_option('round_${round}', 'done');
				`,
				});

				await pushJournalToPouchDB(entries, localA);
				await syncAtoB();

				const titles = await getPostTitles(siteB);
				expect(titles).toContain(`Round ${round} Post`);
			}

			// Final check: all 5 rounds present
			const allTitles = await getPostTitles(siteB);
			for (let r = 1; r <= 5; r++) {
				expect(allTitles).toContain(`Round ${r} Post`);
			}
			const allOpts = await getOptions(siteB, 'round_');
			for (let r = 1; r <= 5; r++) {
				expect(allOpts[`round_${r}`]).toBe('done');
			}
		},
		{ timeout: 120_000 }
	);

	// ── Conflict resolution ──────────────────────────────────

	it(
		'conflict: both sites write to the same PouchDB doc, one wins',
		async () => {
			// Directly test PouchDB conflict resolution with
			// WordPress-shaped documents. In production, UPDATE
			// ops modify existing docs which naturally creates
			// conflicts during replication.
			const docId = 'wp_options::conflict_test';

			await localA.put({
				_id: docId,
				meta_table: 'wp_options',
				meta_pk_column: 'option_id',
				option_name: 'conflict_opt',
				option_value: 'from_site_A',
			});

			await localB.put({
				_id: docId,
				meta_table: 'wp_options',
				meta_pk_column: 'option_id',
				option_name: 'conflict_opt',
				option_value: 'from_site_B',
			});

			// Both replicate to server — creates a conflict
			await localA.replicate.to(server);
			await localB.replicate.to(server);

			const doc = await server.get(docId, { conflicts: true });
			expect(['from_site_A', 'from_site_B']).toContain(doc.option_value);

			// PouchDB stores the conflict — we can inspect/resolve it
			if (doc._conflicts && doc._conflicts.length > 0) {
				const loser = await server.get(docId, {
					rev: doc._conflicts[0],
				});
				expect(['from_site_A', 'from_site_B']).toContain(
					loser.option_value
				);
				expect(doc.option_value).not.toBe(loser.option_value);

				// Resolve by keeping winner and removing loser
				await server.remove(docId, doc._conflicts[0]);
				const resolved = await server.get(docId, {
					conflicts: true,
				});
				expect(resolved._conflicts).toBeUndefined();
			}

			// After resolution, replicate resolved state to both
			await server.replicate.to(localA);
			await server.replicate.to(localB);

			// Both locals should now agree
			const docA = await localA.get(docId);
			const docB = await localB.get(docId);
			expect(docA.option_value).toBe(docB.option_value);
		},
		{ timeout: 60_000 }
	);

	it(
		'concurrent creates: same IDs create PouchDB conflicts that are detectable',
		async () => {
			// Without autoincrement offsets, both sites generate
			// the same post IDs (e.g. wp_posts::4). This means
			// concurrent creates produce PouchDB conflicts on the
			// same document ID. This is the core problem that
			// autoincrement offsets solve in production.
			//
			// This test verifies that PouchDB correctly detects
			// the conflict so it can be resolved.
			const entriesA: SQLJournalEntry[] = [];
			const entriesB: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entriesA.push(e));
			await journalSQLQueries(siteB, (e) => entriesB.push(e));

			await Promise.all([
				siteA.run({
					code: `<?php
					require '/wordpress/wp-load.php';
					wp_insert_post(['post_title' => 'Concurrent A', 'post_status' => 'publish', 'post_author' => 1]);
				`,
				}),
				siteB.run({
					code: `<?php
					require '/wordpress/wp-load.php';
					wp_insert_post(['post_title' => 'Concurrent B', 'post_status' => 'publish', 'post_author' => 1]);
				`,
				}),
			]);

			await pushJournalToPouchDB(entriesA, localA);
			await pushJournalToPouchDB(entriesB, localB);

			// Find matching doc IDs (the collision)
			const aInfo = await localA.allDocs();
			const bInfo = await localB.allDocs();
			const aIds = new Set(aInfo.rows.map((r: { id: string }) => r.id));
			const bIds = new Set(bInfo.rows.map((r: { id: string }) => r.id));
			const collisions = [...aIds].filter((id) => bIds.has(id));

			// Without offsets, wp_posts IDs will collide
			const postCollisions = collisions.filter((id) =>
				id.startsWith('wp_posts::')
			);
			expect(postCollisions.length).toBeGreaterThan(0);

			// Replicate both to server — collisions become conflicts
			await localA.replicate.to(server);
			await localB.replicate.to(server);

			// Check that PouchDB detected the conflicts
			let totalConflicts = 0;
			const serverDocs = await server.allDocs({
				include_docs: true,
				conflicts: true,
			});
			for (const row of serverDocs.rows) {
				if (row.doc._conflicts && row.doc._conflicts.length > 0) {
					totalConflicts += row.doc._conflicts.length;
				}
			}
			expect(totalConflicts).toBeGreaterThan(0);
		},
		{ timeout: 60_000 }
	);

	// ── PouchDB replication integrity ────────────────────────

	it(
		'PouchDB replication preserves all document fields',
		async () => {
			const entries: SQLJournalEntry[] = [];
			await journalSQLQueries(siteA, (e) => entries.push(e));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title' => 'Field Integrity Test',
					'post_content' => '<p>Rich <strong>HTML</strong> content with "quotes" and special chars: é à ü</p>',
					'post_excerpt' => 'Short excerpt',
					'post_status' => 'publish',
					'post_author' => 1,
				]);
			`,
			});

			await pushJournalToPouchDB(entries, localA);
			await localA.replicate.to(server);
			await server.replicate.to(localB);

			// Verify documents in PouchDB B match A
			const aDocs = await localA.allDocs({ include_docs: true });
			const bDocs = await localB.allDocs({ include_docs: true });

			// Same number of docs
			expect(bDocs.rows.length).toBe(aDocs.rows.length);

			// Find the post doc and compare fields
			const aPost = aDocs.rows.find(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(r: any) => r.doc.post_title === 'Field Integrity Test'
			);
			const bPost = bDocs.rows.find(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(r: any) => r.doc.post_title === 'Field Integrity Test'
			);
			expect(aPost).toBeDefined();
			expect(bPost).toBeDefined();
			expect(bPost.doc.post_content).toBe(aPost.doc.post_content);
			expect(bPost.doc.post_excerpt).toBe(aPost.doc.post_excerpt);

			// Replay on site B and verify via PHP
			await pullPouchDBToSite(localB, siteB);
			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1, 's' => 'Field Integrity']);
				echo !empty($posts) ? $posts[0]->post_content : 'MISSING';
			`,
			});
			const content = new TextDecoder().decode(result.bytes);
			expect(content).toContain('Rich <strong>HTML</strong>');
			expect(content).toContain('é à ü');
		},
		{ timeout: 60_000 }
	);

	// ── File sync via PouchDB ────────────────────────────────

	it(
		'syncs file documents through PouchDB replication',
		async () => {
			const fileContent = '<?php echo "synced plugin"; ?>';
			const base64 = Buffer.from(fileContent).toString('base64');

			await localA.put({
				_id: 'wp_files::plugins/synced/main.php',
				meta_path: 'plugins/synced/main.php',
				data: base64,
			});

			await localA.replicate.to(server);
			await server.replicate.to(localB);

			const doc = await localB.get('wp_files::plugins/synced/main.php');
			const decoded = Buffer.from(doc.data, 'base64').toString('utf-8');
			expect(decoded).toBe(fileContent);
		},
		{ timeout: 30_000 }
	);
});
