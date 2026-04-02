import type { PlaygroundClient } from '@wp-playground/remote';

const SQLITE_PATH = '/wordpress/wp-content/database/.ht.sqlite';
const IDB_DB_NAME_PREFIX = 'couchbase-sqlite-sync-';
const IDB_STORE = 'sqlite-snapshots';
const IDB_KEY = 'latest';

/**
 * Tracks the last known SQLite file-change counter so we can
 * skip IndexedDB writes when nothing has changed. SQLite stores
 * a 4-byte counter at byte offset 24 that increments on every
 * write transaction.
 */
let lastChangeCounter = -1;

/**
 * Cached IDB connection to avoid open/close overhead on every
 * snapshot.
 */
let cachedDb: IDBDatabase | null = null;
let cachedDbName: string | null = null;

/**
 * Reads the SQLite database file from the WASM virtual filesystem
 * and stores it in IndexedDB. Skips the write if the file has
 * not changed since the last snapshot.
 */
export async function snapshotSqliteToIndexedDB(
	playground: PlaygroundClient,
	dbName: string
): Promise<boolean> {
	const data = new Uint8Array(await playground.readFileAsBuffer(SQLITE_PATH));

	// Fast change detection: read SQLite's file-change counter
	// (4 bytes at offset 24, big-endian). This counter increments
	// on every write transaction, so it's a reliable and cheap
	// way to detect changes without hashing the whole file.
	const counter = readSqliteChangeCounter(data);
	if (counter === lastChangeCounter) {
		return false;
	}

	await writeToIDB(dbName, data);
	lastChangeCounter = counter;
	return true;
}

/**
 * Reads the SQLite database file from IndexedDB and writes it
 * back into the WASM virtual filesystem. Called on boot to
 * restore the previous state.
 *
 * Returns true if a snapshot was restored, false if no snapshot
 * existed.
 */
export async function restoreSqliteFromIndexedDB(
	playground: PlaygroundClient,
	dbName: string
): Promise<boolean> {
	const data = await readFromIDB(dbName);
	if (!data || data.byteLength === 0) {
		return false;
	}
	await playground.writeFile(SQLITE_PATH, data);

	// Seed the change counter so the first snapshot after
	// restore doesn't re-write unchanged data.
	lastChangeCounter = readSqliteChangeCounter(data);
	return true;
}

/**
 * Checks whether a SQLite snapshot exists in IndexedDB.
 */
export async function hasSqliteSnapshot(dbName: string): Promise<boolean> {
	const data = await readFromIDB(dbName);
	return data !== null && data.byteLength > 0;
}

/**
 * Reads the SQLite file-change counter from the database header.
 * This is a 4-byte big-endian integer at byte offset 24 that
 * SQLite increments on every write transaction. Returns -1 if
 * the file is too small to contain a valid header.
 *
 * See: https://www.sqlite.org/fileformat.html#the_database_header
 */
function readSqliteChangeCounter(data: Uint8Array): number {
	if (data.byteLength < 28) {
		return -1;
	}
	return (data[24] << 24) | (data[25] << 16) | (data[26] << 8) | data[27];
}

function idbName(dbName: string): string {
	return `${IDB_DB_NAME_PREFIX}${dbName}`;
}

async function getDb(dbName: string): Promise<IDBDatabase> {
	if (cachedDb && cachedDbName === dbName) {
		return cachedDb;
	}
	if (cachedDb) {
		cachedDb.close();
	}
	cachedDb = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(idbName(dbName), 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) {
				db.createObjectStore(IDB_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	cachedDbName = dbName;
	return cachedDb;
}

async function writeToIDB(dbName: string, data: Uint8Array): Promise<void> {
	const db = await getDb(dbName);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, 'readwrite');
		tx.objectStore(IDB_STORE).put(data.buffer, IDB_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function readFromIDB(dbName: string): Promise<Uint8Array | null> {
	let db: IDBDatabase;
	try {
		db = await getDb(dbName);
	} catch {
		return null;
	}
	return new Promise((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, 'readonly');
		const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
		request.onsuccess = () => {
			const result = request.result;
			if (result instanceof ArrayBuffer) {
				resolve(new Uint8Array(result));
			} else {
				resolve(null);
			}
		};
		request.onerror = () => reject(request.error);
	});
}
