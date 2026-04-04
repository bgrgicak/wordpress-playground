import type { PlaygroundClient } from '@wp-playground/remote';
import type { CouchbaseDatabase } from './couchbase-database';

const WP_CONTENT_PATH = '/wordpress/wp-content';

/**
 * Cache of the previous snapshot's row data, keyed by docId,
 * scoped per CouchbaseDatabase instance. Prevents the cache
 * from leaking between different databases (e.g. in tests).
 */
const snapshotCaches = new WeakMap<CouchbaseDatabase, Map<string, string>>();

function getSnapshotCache(cbDb: CouchbaseDatabase): Map<string, string> {
	let cache = snapshotCaches.get(cbDb);
	if (!cache) {
		cache = new Map();
		snapshotCaches.set(cbDb, cache);
	}
	return cache;
}

/**
 * Serializes a row into a string for comparison. Uses a stable
 * JSON representation of sorted keys + values.
 */
function rowFingerprint(row: Record<string, unknown>): string {
	const keys = Object.keys(row).sort();
	const parts: string[] = [];
	for (const key of keys) {
		parts.push(`${key}=${String(row[key])}`);
	}
	return parts.join('|');
}

/**
 * Primes the snapshot cache from PouchDB documents. Call this
 * after restoring from PouchDB so the first periodic snapshot
 * doesn't re-write all the restored data (which would create
 * unnecessary PouchDB revisions and overwrite remote changes
 * that arrived via replication).
 *
 * This reads from PouchDB (IndexedDB), not from PHP, so it
 * doesn't block the WordPress runtime.
 */
export async function primeSnapshotCacheFromPouchDB(
	cbDb: CouchbaseDatabase
): Promise<void> {
	const collections = await cbDb.discoverCollections();
	const dataCollections = collections.filter(
		(c) =>
			c !== 'wp_files' &&
			!c.startsWith('tbl_wp_sqlite_') &&
			!c.startsWith('_wp_sqlite_')
	);

	for (const collection of dataCollections) {
		const docs = await cbDb.getAllDocuments(collection);
		for (const doc of docs) {
			if (!doc.body) {
				continue;
			}
			// Build the same fingerprint that snapshotSqlToPouchDB
			// would compute from the PHP row. The doc body contains
			// meta_table, meta_pk_column, and all row columns.
			// Strip metadata fields to match the PHP row shape.
			const row: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(doc.body)) {
				if (
					key === 'meta_table' ||
					key === 'meta_pk_column' ||
					key === '_deleted' ||
					key === '_attachments'
				) {
					continue;
				}
				row[key] = value;
			}
			getSnapshotCache(cbDb).set(doc.docId, rowFingerprint(row));
		}
	}
}

/**
 * Snapshots ALL existing WordPress database rows into PouchDB.
 *
 * This reads every row from every WordPress table via PHP and
 * converts each to a PouchDB document. This is called on first
 * save to capture the full initial state — not just incremental
 * changes.
 *
 * On subsequent calls (periodic snapshots), only rows that
 * changed since the last snapshot are written to PouchDB. This
 * prevents overwriting documents that arrived via remote
 * replication with stale local data.
 *
 * Returns the total number of rows captured.
 */
export async function snapshotSqlToPouchDB(
	playground: PlaygroundClient,
	cbDb: CouchbaseDatabase
): Promise<number> {
	// Discover all tables (including any custom ones)
	const tableResult = await playground.run({
		code: `<?php
		require '/wordpress/wp-load.php';
		global $wpdb;
		$pdo = $GLOBALS['@pdo'];
		$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'playground_%' AND name NOT LIKE '\\_wp\\_sqlite\\_%' ESCAPE '\\\\'")
			->fetchAll(PDO::FETCH_COLUMN);
		echo json_encode($tables);
	`,
	});
	const tables: string[] = JSON.parse(
		new TextDecoder().decode(tableResult.bytes)
	);

	let totalRows = 0;

	for (const table of tables) {
		// Get all rows from this table
		const result = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			global $wpdb;
			$pdo = $GLOBALS['@pdo'];
			$stmt = $pdo->query("SELECT * FROM \`${table}\`");
			$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

			// Find the primary key column (first INTEGER PRIMARY KEY)
			$cols = $pdo->query("PRAGMA table_info(\`${table}\`)")->fetchAll(PDO::FETCH_ASSOC);
			$pk_col = 'id';
			foreach ($cols as $col) {
				if ($col['pk'] == 1) {
					$pk_col = $col['name'];
					break;
				}
			}

			echo json_encode(['rows' => $rows, 'pk_column' => $pk_col]);
		`,
		});

		let data: { rows: Record<string, unknown>[]; pk_column: string };
		try {
			data = JSON.parse(new TextDecoder().decode(result.bytes));
		} catch {
			continue;
		}

		if (!data.rows || data.rows.length === 0) {
			continue;
		}

		const ops = [];
		for (const row of data.rows) {
			const pkValue = row[data.pk_column];
			if (pkValue == null) {
				continue;
			}
			// Skip per-site options that should NOT be replicated
			// to other sites via the shared remote database.
			if (row.option_name === 'playground_id_offset') {
				continue;
			}
			let docId = `${table}::${pkValue}`;
			// PouchDB rejects _ids starting with underscore
			if (docId.startsWith('_')) {
				docId = 'tbl' + docId;
			}

			// Only write if this row changed since the last
			// snapshot. This prevents overwriting documents that
			// arrived via remote replication.
			const fp = rowFingerprint(row);
			if (getSnapshotCache(cbDb).get(docId) === fp) {
				continue;
			}
			getSnapshotCache(cbDb).set(docId, fp);

			ops.push({
				type: 'save' as const,
				collection: table,
				docId,
				body: {
					meta_table: table,
					meta_pk_column: data.pk_column,
					...row,
				},
			});
		}

		await cbDb.applyCouchbaseOps(ops);
		totalRows += ops.length;
	}

	return totalRows;
}

// ── Incremental snapshot infrastructure ─────────────────────

interface TableMeta {
	count: number;
	maxPk: string;
	pkColumn: string;
}

/**
 * Per-database cache of table metadata from the previous
 * incremental snapshot cycle. Used to skip tables whose
 * row count and max PK haven't changed.
 */
const metaCaches = new WeakMap<CouchbaseDatabase, Map<string, TableMeta>>();

function getMetaCache(cbDb: CouchbaseDatabase): Map<string, TableMeta> {
	let cache = metaCaches.get(cbDb);
	if (!cache) {
		cache = new Map();
		metaCaches.set(cbDb, cache);
	}
	return cache;
}

/**
 * Incremental snapshot: fetches lightweight metadata (COUNT +
 * MAX(pk)) for all tables in a single PHP call, then only
 * full-scans tables whose metadata changed since the last
 * cycle. Also detects deleted rows when a table's count
 * decreases.
 *
 * @param forceFullSweep When true, full-scan ALL tables
 *   regardless of metadata changes. Used periodically (e.g.
 *   every 60s) to catch in-place UPDATEs that don't change
 *   count or max_pk.
 * @returns Object with counts of rows written and tables
 *   scanned.
 */
export async function incrementalSnapshotSqlToPouchDB(
	playground: PlaygroundClient,
	cbDb: CouchbaseDatabase,
	forceFullSweep = false
): Promise<{ rowsWritten: number; tablesScanned: number }> {
	// Step 1: Get metadata for all tables in one PHP call
	const metaResult = await playground.run({
		code: `<?php
		require '/wordpress/wp-load.php';
		$pdo = $GLOBALS['@pdo'];
		$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'playground_%' AND name NOT LIKE '\\_wp\\_sqlite\\_%' ESCAPE '\\\\'")
			->fetchAll(PDO::FETCH_COLUMN);
		$meta = [];
		foreach ($tables as $t) {
			$cols = $pdo->query("PRAGMA table_info(" . chr(96) . $t . chr(96) . ")")->fetchAll(PDO::FETCH_ASSOC);
			$pk_col = 'id';
			foreach ($cols as $col) {
				if ($col['pk'] == 1) { $pk_col = $col['name']; break; }
			}
			$row = $pdo->query("SELECT COUNT(*) as cnt, MAX(" . chr(96) . $pk_col . chr(96) . ") as max_pk FROM " . chr(96) . $t . chr(96))->fetch(PDO::FETCH_ASSOC);
			$meta[$t] = ['count' => (int)$row['cnt'], 'maxPk' => (string)($row['max_pk'] ?? ''), 'pkColumn' => $pk_col];
		}
		echo json_encode($meta);
		`,
	});

	let allMeta: Record<string, TableMeta>;
	try {
		allMeta = JSON.parse(new TextDecoder().decode(metaResult.bytes));
	} catch {
		// If metadata fetch fails, fall back to full snapshot
		const rowsWritten = await snapshotSqlToPouchDB(playground, cbDb);
		return { rowsWritten, tablesScanned: -1 };
	}

	const metaCache = getMetaCache(cbDb);
	const tablesToScan: string[] = [];

	for (const [table, meta] of Object.entries(allMeta)) {
		const prev = metaCache.get(table);
		if (
			forceFullSweep ||
			!prev ||
			prev.count !== meta.count ||
			prev.maxPk !== meta.maxPk
		) {
			tablesToScan.push(table);
		}
	}

	// Step 2: Full-scan only changed tables
	let rowsWritten = 0;
	for (const table of tablesToScan) {
		const meta = allMeta[table];
		const result = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			$pdo = $GLOBALS['@pdo'];
			$rows = $pdo->query("SELECT * FROM \`${table}\`")->fetchAll(PDO::FETCH_ASSOC);
			echo json_encode($rows);
			`,
		});

		let rows: Record<string, unknown>[];
		try {
			rows = JSON.parse(new TextDecoder().decode(result.bytes));
		} catch {
			// eslint-disable-next-line no-console
			console.error(
				`[CouchbaseSync] Failed to parse rows for ${table}:`,
				new TextDecoder().decode(result.bytes).slice(0, 200)
			);
			continue;
		}

		const cache = getSnapshotCache(cbDb);
		const ops = [];
		const currentDocIds = new Set<string>();

		for (const row of rows) {
			const pkValue = row[meta.pkColumn];
			if (pkValue == null) {
				continue;
			}
			if (row.option_name === 'playground_id_offset') {
				continue;
			}
			let docId = `${table}::${pkValue}`;
			if (docId.startsWith('_')) {
				docId = 'tbl' + docId;
			}
			currentDocIds.add(docId);

			const fp = rowFingerprint(row);
			if (cache.get(docId) === fp) {
				continue;
			}
			cache.set(docId, fp);

			ops.push({
				type: 'save' as const,
				collection: table,
				docId,
				body: {
					meta_table: table,
					meta_pk_column: meta.pkColumn,
					...row,
				},
			});
		}

		await cbDb.applyCouchbaseOps(ops);
		rowsWritten += ops.length;

		// Step 3: Detect and remove deleted rows
		const prev = metaCache.get(table);
		if (prev && meta.count < prev.count) {
			const pouchDocs = await cbDb.getAllDocuments(table);
			for (const doc of pouchDocs) {
				if (!currentDocIds.has(doc.docId)) {
					await cbDb.applyCouchbaseOps([
						{
							type: 'delete' as const,
							collection: table,
							docId: doc.docId,
							query: '',
						},
					]);
					cache.delete(doc.docId);
				}
			}
		}

		metaCache.set(table, meta);
	}

	// Update metadata for tables that weren't scanned
	for (const [table, meta] of Object.entries(allMeta)) {
		if (!tablesToScan.includes(table)) {
			metaCache.set(table, meta);
		}
	}

	return { rowsWritten, tablesScanned: tablesToScan.length };
}

/**
 * Snapshots ALL existing wp-content files into PouchDB.
 *
 * Recursively walks /wordpress/wp-content and stores each file
 * as a base64-encoded PouchDB document. Called on first save to
 * capture themes, plugins, uploads, mu-plugins, etc.
 *
 * Returns the number of files captured.
 */
export async function snapshotFilesToPouchDB(
	playground: PlaygroundClient,
	cbDb: CouchbaseDatabase
): Promise<number> {
	// Get all file paths via PHP (faster than JS recursive walk
	// over Comlink)
	const result = await playground.run({
		code: `<?php
		$files = [];
		$root = '/wordpress/wp-content';
		$iter = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator($root,
				RecursiveDirectoryIterator::SKIP_DOTS)
		);
		foreach ($iter as $file) {
			if ($file->isFile()) {
				$rel = substr($file->getPathname(), strlen($root) + 1);
				$name = basename($rel);
				if ($name === '.ht.sqlite' || $name === '.ht.sqlite-journal') {
					continue;
				}
				$files[] = $rel;
			}
		}
		echo json_encode($files);
	`,
	});

	const filePaths: string[] = JSON.parse(
		new TextDecoder().decode(result.bytes)
	);

	for (const relPath of filePaths) {
		const absPath = `${WP_CONTENT_PATH}/${relPath}`;
		const data = new Uint8Array(await playground.readFileAsBuffer(absPath));
		// Base64 encode
		let binary = '';
		for (let i = 0; i < data.length; i++) {
			binary += String.fromCharCode(data[i]);
		}
		const base64 =
			typeof btoa === 'function'
				? btoa(binary)
				: Buffer.from(data).toString('base64');
		await cbDb.saveFile(relPath, base64);
	}

	return filePaths.length;
}
