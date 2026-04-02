import type { PlaygroundClient } from '@wp-playground/remote';
import type { CouchbaseDatabase } from './couchbase-database';
import { sqlJournalEntryToCouchbaseOps } from './sql-to-couchbase';
import type { SQLJournalEntry } from '@wp-playground/sync';

const WP_CONTENT_PATH = '/wordpress/wp-content';

/**
 * Files to skip during filesystem snapshots. The SQLite database
 * is handled separately via the SQL pipeline.
 */
const EXCLUDED_FILES = new Set(['.ht.sqlite', '.ht.sqlite-journal']);

/**
 * WordPress core tables to snapshot. Additional tables discovered
 * at runtime are also included.
 */
const WP_TABLES = [
	'wp_posts',
	'wp_postmeta',
	'wp_comments',
	'wp_commentmeta',
	'wp_terms',
	'wp_term_taxonomy',
	'wp_term_relationships',
	'wp_options',
	'wp_users',
	'wp_usermeta',
	'wp_links',
];

/**
 * Snapshots ALL existing WordPress database rows into PouchDB.
 *
 * This reads every row from every WordPress table via PHP and
 * converts each to a PouchDB document. This is called on first
 * save to capture the full initial state — not just incremental
 * changes.
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
		$tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'playground_%'")
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
			let docId = `${table}::${pkValue}`;
			// PouchDB rejects _ids starting with underscore
			if (docId.startsWith('_')) {
				docId = 'tbl' + docId;
			}
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
