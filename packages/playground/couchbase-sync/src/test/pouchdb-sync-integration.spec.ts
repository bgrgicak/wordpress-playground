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

// PouchDB runs CouchDB-compatible storage entirely in Node.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PouchDB = require('pouchdb');
// eslint-disable-next-line @typescript-eslint/no-require-imports
PouchDB.plugin(require('pouchdb-adapter-memory'));

/**
 * Converts a Couchbase save doc to PouchDB format.
 * Since metadata fields now use `meta_` prefix instead of `_`,
 * the body is already PouchDB-compatible.
 */
function toPouchDoc(doc: {
	collection: string;
	docId: string;
	body: Record<string, unknown>;
}) {
	// docId already contains the collection prefix (e.g. "wp_posts::42")
	return {
		_id: doc.docId,
		...doc.body,
	};
}

/**
 * Converts a PouchDB doc back to the CouchbaseDocChange format
 * for the conversion functions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromPouchDoc(doc: any) {
	const collection = parseCollection(doc._id);
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(doc)) {
		if (key === '_id' || key === '_rev') {
			continue;
		}
		body[key] = value;
	}
	return {
		collection: collection ?? '',
		docId: doc._id as string,
		deleted: false,
		body,
	};
}

function parseCollection(id: string): string | null {
	const idx = id.indexOf('::');
	return idx === -1 ? null : id.slice(0, idx);
}

describe('PouchDB Integration - Two-site sync', () => {
	let siteA: PHP;
	let siteB: PHP;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let serverDb: any;

	beforeEach(async () => {
		serverDb = new PouchDB(`test-server-${Date.now()}`, {
			adapter: 'memory',
		});

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

	afterEach(async () => {
		if (serverDb) {
			await serverDb.destroy();
		}
	});

	it(
		'syncs a post: Site A → PouchDB → Site B',
		async () => {
			const entriesA: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));
			await installSqlSyncMuPlugin(siteB);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'PouchDB Sync Post',
					'post_content' => 'Synced via PouchDB!',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
			`,
			});

			// Journal → Couchbase docs → PouchDB
			const docs = journalToSaveDocs(entriesA);
			for (const doc of docs) {
				await serverDb.put(toPouchDoc(doc));
			}

			// Pull from PouchDB → SQL → site B
			const allDocs = await serverDb.allDocs({ include_docs: true });
			const sqlForB: SQLJournalEntry[] = [];
			for (const row of allDocs.rows) {
				const change = fromPouchDoc(row.doc);
				const entry = couchbaseChangeToSqlJournalEntry(change);
				if (entry) {
					sqlForB.push(entry);
				}
			}
			await replaySqlIgnoringOutput(siteB, sqlForB);

			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
				foreach ($posts as $p) {
					if ($p->post_title === 'PouchDB Sync Post') {
						echo json_encode(['title' => $p->post_title, 'content' => $p->post_content]);
						exit;
					}
				}
				echo json_encode(['error' => 'not found']);
			`,
			});

			const parsed = JSON.parse(new TextDecoder().decode(result.bytes));
			expect(parsed.title).toBe('PouchDB Sync Post');
			expect(parsed.content).toContain('Synced via PouchDB!');
		},
		{ timeout: 60_000 }
	);

	it(
		'PouchDB replication syncs documents between two databases',
		async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localA: any = new PouchDB(`local-a-${Date.now()}`, {
				adapter: 'memory',
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localB: any = new PouchDB(`local-b-${Date.now()}`, {
				adapter: 'memory',
			});

			const entriesA: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'Replicated Post',
					'post_content' => 'Via PouchDB replication!',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
			`,
			});

			const docs = journalToSaveDocs(entriesA);
			for (const doc of docs) {
				await localA.put(toPouchDoc(doc));
			}

			// PouchDB built-in replication (CouchDB protocol)
			await localA.replicate.to(serverDb);
			await serverDb.replicate.to(localB);

			const bDocs = await localB.allDocs({ include_docs: true });
			expect(bDocs.rows.length).toBeGreaterThan(0);

			const postDoc = bDocs.rows.find(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(r: any) => r.doc.meta_table === 'wp_posts'
			);
			expect(postDoc).toBeDefined();
			expect(postDoc.doc.post_title).toBe('Replicated Post');

			await localA.destroy();
			await localB.destroy();
		},
		{ timeout: 60_000 }
	);

	it(
		'PouchDB handles concurrent writes with conflict resolution',
		async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localA: any = new PouchDB(`conflict-a-${Date.now()}`, {
				adapter: 'memory',
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localB: any = new PouchDB(`conflict-b-${Date.now()}`, {
				adapter: 'memory',
			});

			const docId = 'wp_options::tagline';

			await localA.put({
				_id: docId,
				collection: 'wp_options',
				docId: 'tagline',
				option_name: 'blogdescription',
				option_value: 'Site A tagline',
			});

			await localB.put({
				_id: docId,
				collection: 'wp_options',
				docId: 'tagline',
				option_name: 'blogdescription',
				option_value: 'Site B tagline',
			});

			// Both replicate to server — creates a conflict
			await localA.replicate.to(serverDb);
			await localB.replicate.to(serverDb);

			const serverDoc = await serverDb.get(docId, { conflicts: true });
			expect(serverDoc.option_name).toBe('blogdescription');
			expect(['Site A tagline', 'Site B tagline']).toContain(
				serverDoc.option_value
			);

			// There should be a conflict with one losing revision
			expect(serverDoc._conflicts).toBeDefined();
			expect(serverDoc._conflicts.length).toBe(1);

			// Resolve by deleting the losing revision
			const losingRev = serverDoc._conflicts[0];
			await serverDb.remove(docId, losingRev);
			const resolved = await serverDb.get(docId, { conflicts: true });
			expect(resolved._conflicts).toBeUndefined();

			await localA.destroy();
			await localB.destroy();
		},
		{ timeout: 30_000 }
	);

	it(
		'syncs file documents through PouchDB replication',
		async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localA: any = new PouchDB(`fs-a-${Date.now()}`, {
				adapter: 'memory',
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localB: any = new PouchDB(`fs-b-${Date.now()}`, {
				adapter: 'memory',
			});

			const fileContent = '<?php echo "hello from PouchDB"; ?>';
			const base64 = Buffer.from(fileContent).toString('base64');
			const filePath = 'plugins/pouchdb-test/main.php';

			await localA.put({
				_id: `wp_files::${filePath}`,
				collection: 'wp_files',
				path: filePath,
				data: base64,
			});

			await localA.replicate.to(serverDb);
			await serverDb.replicate.to(localB);

			const doc = await localB.get(`wp_files::${filePath}`);
			expect(doc.path).toBe(filePath);

			const decoded = Buffer.from(doc.data, 'base64').toString('utf-8');
			expect(decoded).toBe(fileContent);

			await localA.destroy();
			await localB.destroy();
		},
		{ timeout: 30_000 }
	);

	it(
		'full round-trip: Site A → PouchDB replication → Site B',
		async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localA: any = new PouchDB(`full-a-${Date.now()}`, {
				adapter: 'memory',
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const localB: any = new PouchDB(`full-b-${Date.now()}`, {
				adapter: 'memory',
			});

			const entriesA: SQLJournalEntry[] = [];
			await installSqlSyncMuPlugin(siteA);
			await journalSQLQueries(siteA, (entry) => entriesA.push(entry));
			await installSqlSyncMuPlugin(siteB);

			await siteA.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				wp_insert_post([
					'post_title'   => 'Full Round Trip',
					'post_content' => 'End-to-end via PouchDB.',
					'post_status'  => 'publish',
					'post_author'  => 1,
				]);
				update_option('round_trip_test', 'it_works');
			`,
			});

			// SQL journal → Couchbase docs → PouchDB local A
			const docs = journalToSaveDocs(entriesA);
			for (const doc of docs) {
				await localA.put(toPouchDoc(doc));
			}

			// PouchDB replication: A → server → B
			await localA.replicate.to(serverDb);
			await serverDb.replicate.to(localB);

			// PouchDB B → SQL journal → site B
			const bDocs = await localB.allDocs({ include_docs: true });
			const sqlForB: SQLJournalEntry[] = [];
			for (const row of bDocs.rows) {
				const change = fromPouchDoc(row.doc);
				const entry = couchbaseChangeToSqlJournalEntry(change);
				if (entry) {
					sqlForB.push(entry);
				}
			}
			await replaySqlIgnoringOutput(siteB, sqlForB);

			const result = await siteB.run({
				code: `<?php
				require '/wordpress/wp-load.php';
				$posts = get_posts(['post_status' => 'publish', 'numberposts' => -1]);
				$found = false;
				foreach ($posts as $p) {
					if ($p->post_title === 'Full Round Trip') { $found = true; break; }
				}
				echo json_encode([
					'post_found' => $found,
					'option' => get_option('round_trip_test', 'NOT_SET'),
				]);
			`,
			});

			const parsed = JSON.parse(new TextDecoder().decode(result.bytes));
			expect(parsed.post_found).toBe(true);
			expect(parsed.option).toBe('it_works');

			await localA.destroy();
			await localB.destroy();
		},
		{ timeout: 60_000 }
	);
});

// ── Helpers ──────────────────────────────────────────────────

function journalToSaveDocs(entries: SQLJournalEntry[]) {
	const docs: Array<{
		collection: string;
		docId: string;
		body: Record<string, unknown>;
	}> = [];
	const writeEntries = entries.filter(
		(e) => e.query_type !== 'SELECT' && e.table_name !== ''
	);
	for (const entry of writeEntries) {
		const ops = sqlJournalEntryToCouchbaseOps(entry);
		for (const op of ops) {
			if (op.type === 'save') {
				docs.push({
					collection: op.collection,
					docId: op.docId,
					body: op.body,
				});
			}
		}
	}
	return docs;
}

async function replaySqlIgnoringOutput(
	php: PHP,
	entries: SQLJournalEntry[]
): Promise<void> {
	if (!entries.length) {
		return;
	}
	try {
		await replaySQLJournal(php, entries);
	} catch {
		// WordPress hooks may produce debug output during replay
	}
}
