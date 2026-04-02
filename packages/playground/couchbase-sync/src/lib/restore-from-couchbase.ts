import type { PlaygroundClient } from '@wp-playground/remote';
import { replaySQLJournal } from '@wp-playground/sync';
import type { SQLJournalEntry } from '@wp-playground/sync';
import type { CouchbaseDatabase } from './couchbase-database';
import { couchbaseChangeToSqlJournalEntry } from './couchbase-to-sql';

const WP_CONTENT_PATH = '/wordpress/wp-content';

/**
 * Max entries per replaySQLJournal call. Larger batches cause
 * stack overflow in phpVars() base64 encoding.
 */
const SQL_BATCH_SIZE = 20;

/**
 * Restores the full WordPress state from a CouchbaseDatabase
 * into the running WASM instance. This includes both:
 *
 * 1. **Database rows** — read all documents from data collections,
 *    convert to REPLACE INTO SQL, and replay on the PHP instance.
 * 2. **Filesystem (wp-content)** — read all file documents,
 *    decode from base64, and write into the WASM filesystem.
 *
 * This is called on boot for return visits where a previous
 * session's data is persisted in Couchbase Lite (IndexedDB).
 */
export async function restoreFromCouchbase(
	playground: PlaygroundClient,
	cbDb: CouchbaseDatabase
): Promise<{ sqlCount: number; fileCount: number }> {
	let sqlCount = 0;
	let fileCount = 0;

	// 1. Restore database rows (batched to avoid stack overflow
	//    in phpVars serialization)
	// Discover ALL collections from PouchDB instead of relying
	// on a hardcoded list. The snapshot may include custom tables
	// not in WP_CORE_TABLES.
	const allCollections = await cbDb.discoverCollections();
	const dataCollections = allCollections.filter(
		(c) =>
			c !== 'wp_files' &&
			// Skip SQLite integration internal tables — the
			// _wp_sqlite_ prefix is reserved and REPLACE INTO
			// these tables throws "Invalid identifier" errors.
			!c.startsWith('tbl_wp_sqlite_') &&
			!c.startsWith('_wp_sqlite_')
	);
	// eslint-disable-next-line no-console
	console.log(
		`[CouchbaseSync] Restoring from ${dataCollections.length} collections:`,
		dataCollections.join(', ')
	);
	const allSqlEntries: SQLJournalEntry[] = [];

	for (const collectionName of dataCollections) {
		const docs = await cbDb.getAllDocuments(collectionName);
		for (const doc of docs) {
			const entry = couchbaseChangeToSqlJournalEntry(doc);
			if (entry) {
				allSqlEntries.push(entry);
			}
		}
	}

	for (let i = 0; i < allSqlEntries.length; i += SQL_BATCH_SIZE) {
		const batch = allSqlEntries.slice(i, i + SQL_BATCH_SIZE);
		await replaySQLJournal(playground, batch);
	}
	sqlCount = allSqlEntries.length;

	// 2. Restore filesystem files
	const files = await cbDb.getAllFiles();
	const createdDirs = new Set<string>();

	for (const file of files) {
		const absPath = `${WP_CONTENT_PATH}/${file.path}`;

		// Ensure parent directories exist
		const parts = file.path.split('/');
		let dirSoFar = WP_CONTENT_PATH;
		for (let i = 0; i < parts.length - 1; i++) {
			dirSoFar += '/' + parts[i];
			if (!createdDirs.has(dirSoFar)) {
				try {
					if (!(await playground.fileExists(dirSoFar))) {
						await playground.mkdir(dirSoFar);
					}
				} catch {
					// Directory may already exist
				}
				createdDirs.add(dirSoFar);
			}
		}

		// Decode base64 and write file
		if (file.data) {
			const binary = atob(file.data);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			await playground.writeFile(absPath, bytes);
		}
		fileCount++;
	}

	return { sqlCount, fileCount };
}

/**
 * Checks whether the CouchbaseDatabase has any persisted data
 * (either SQL documents or file documents), indicating a
 * previous session.
 */
export async function hasCouchbaseData(
	cbDb: CouchbaseDatabase
): Promise<boolean> {
	// Quick check: look for any documents in wp_options
	// (always present after a WordPress save)
	const optionDocs = await cbDb.getAllDocuments('wp_options');
	if (optionDocs.length > 0) {
		return true;
	}

	// Fallback: check for any files
	const files = await cbDb.getAllFiles();
	return files.length > 0;
}
