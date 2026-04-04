import type { CouchbaseDatabase } from './couchbase-database';

const OFFSET_DOC_ID = '_local/autoincrement_offset';
const SEQUENCE_DOC_ID = '_local/playground_sequence';

/**
 * Range for random offset generation. Each site picks a random
 * starting point in this range. With a range of 1B and sites
 * creating at most ~10K rows each, the probability of overlap
 * is negligible.
 */
const MIN_OFFSET = 1_000_000;
const MAX_OFFSET = 1_000_000_000;

/**
 * Gets or creates a unique autoincrement offset for this site.
 *
 * On first save, generates a random large number and stores it
 * in PouchDB as a local document (not replicated). On return
 * visits, reads the stored offset.
 *
 * This ensures each collaborating site generates IDs in a
 * different range, avoiding primary key collisions.
 */
export async function getOrCreateOffset(
	cbDb: CouchbaseDatabase
): Promise<number> {
	const db = cbDb.getDatabase();
	if (!db) {
		return randomOffset();
	}

	try {
		// _local/ documents are PouchDB-local and never replicated
		const doc = await db.get(OFFSET_DOC_ID);
		return doc.offset as number;
	} catch {
		// First time — generate and store
		const offset = randomOffset();
		await db.put({
			_id: OFFSET_DOC_ID,
			offset,
		});
		return offset;
	}
}

/**
 * Retrieves the saved playground_sequence values from PouchDB.
 * These are persisted in a _local/ document (not replicated) so
 * they survive page reloads. Returns the saved map of
 * table → last_assigned_id, which can be passed directly to
 * `overrideAutoincrementSequences` as `knownIds`.
 *
 * On first boot (no saved sequence), returns an empty object so
 * the PHP side uses the base offset for all tables.
 */
export async function getSavedSequence(
	cbDb: CouchbaseDatabase
): Promise<Record<string, number>> {
	const db = cbDb.getDatabase();
	if (!db) {
		return {};
	}

	try {
		const doc = await db.get(SEQUENCE_DOC_ID);
		return (doc.sequence as Record<string, number>) ?? {};
	} catch {
		return {};
	}
}

/**
 * Saves the current playground_sequence values to PouchDB so
 * they survive page reloads. Called after each periodic snapshot
 * to keep the saved state fresh.
 */
export async function saveSequence(
	cbDb: CouchbaseDatabase,
	sequence: Record<string, number>
): Promise<void> {
	const db = cbDb.getDatabase();
	if (!db) {
		return;
	}

	try {
		const existing = await db.get(SEQUENCE_DOC_ID);
		await db.put({
			...existing,
			sequence,
		});
	} catch {
		await db.put({
			_id: SEQUENCE_DOC_ID,
			sequence,
		});
	}
}

function randomOffset(): number {
	return MIN_OFFSET + Math.floor(Math.random() * (MAX_OFFSET - MIN_OFFSET));
}
