import type { CouchbaseDatabase } from './couchbase-database';

const OFFSET_DOC_ID = '_local/autoincrement_offset';

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
 * Scans all synced documents in PouchDB to find the maximum
 * primary key value per WordPress table. Returns a map of
 * table → max_id that can be passed to
 * `overrideAutoincrementSequences` as `knownIds`.
 *
 * This ensures the local autoincrement sequence starts above
 * any ID that has been synced from other sites, preventing
 * future collisions.
 */
export async function getMaxSyncedIds(
	cbDb: CouchbaseDatabase
): Promise<Record<string, number>> {
	const maxIds: Record<string, number> = {};
	const collections = cbDb.getDataCollectionNames();

	for (const collection of collections) {
		const docs = await cbDb.getAllDocuments(collection);
		for (const doc of docs) {
			if (!doc.body) {
				continue;
			}
			const pkColumn = (doc.body.meta_pk_column as string) || 'id';
			const pkValue = doc.body[pkColumn];
			if (typeof pkValue === 'number' && pkValue > 0) {
				maxIds[collection] = Math.max(maxIds[collection] ?? 0, pkValue);
			}
		}
	}

	return maxIds;
}

function randomOffset(): number {
	return MIN_OFFSET + Math.floor(Math.random() * (MAX_OFFSET - MIN_OFFSET));
}
