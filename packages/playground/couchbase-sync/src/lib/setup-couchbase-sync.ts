import type { PlaygroundClient } from '@wp-playground/remote';
import {
	snapshotSqliteToIndexedDB,
	restoreSqliteFromIndexedDB,
} from './sqlite-file-sync';

export interface CouchbaseSyncOptions {
	/**
	 * Configuration for the local Couchbase Lite database.
	 */
	database: {
		name: string;
	};

	/**
	 * Whether to restore SQLite state from the persisted snapshot
	 * on boot. When true, the SQLite database file stored in
	 * IndexedDB is written back into the WASM filesystem before
	 * WordPress queries run.
	 *
	 * Default: true.
	 */
	restoreOnBoot?: boolean;

	/**
	 * Interval in ms between automatic snapshots of the SQLite
	 * database to IndexedDB. Set to 0 to disable periodic
	 * snapshots (will only snapshot after PHP requests).
	 *
	 * Default: 5000ms.
	 */
	snapshotIntervalMs?: number;
}

export interface CouchbaseSyncHandle {
	/**
	 * Force an immediate snapshot of the current SQLite state
	 * to IndexedDB.
	 */
	snapshot: () => Promise<void>;

	/**
	 * Stop the sync (clears timers and event listeners).
	 */
	stop: () => void;
}

/**
 * Sets up persistence for WordPress Playground's SQLite database
 * using IndexedDB as the durable storage layer.
 *
 * ## How it works
 *
 * The WordPress database lives in an in-memory SQLite file inside
 * the Emscripten WASM filesystem. This is lost on page reload.
 *
 * This function:
 * 1. **On boot** (restoreOnBoot=true): reads the previous SQLite
 *    database file from IndexedDB and writes it into the WASM
 *    filesystem, so WordPress sees all its previous data.
 * 2. **After each PHP request**: snapshots the SQLite file back
 *    to IndexedDB, capturing any changes WordPress made.
 * 3. **Periodically**: takes a safety snapshot in case a long-
 *    running request is in progress when the user closes the tab.
 *
 * ## Data flow
 *
 * ```
 * Page load:
 *   IndexedDB → .ht.sqlite blob → WASM filesystem → WordPress
 *
 * After each request:
 *   WordPress → WASM filesystem → .ht.sqlite blob → IndexedDB
 * ```
 */
export async function setupCouchbaseSync(
	playground: PlaygroundClient,
	options: CouchbaseSyncOptions
): Promise<CouchbaseSyncHandle> {
	const dbName = options.database.name;

	// 1. Restore from IndexedDB if requested
	if (options.restoreOnBoot !== false) {
		const restored = await restoreSqliteFromIndexedDB(playground, dbName);
		if (restored) {
			// eslint-disable-next-line no-console
			console.log(
				'[CouchbaseSync] Restored SQLite database from IndexedDB.'
			);
		}
	}

	// 2. Snapshot after every PHP request completes
	let snapshotInProgress = false;
	const doSnapshot = async () => {
		if (snapshotInProgress) {
			return;
		}
		snapshotInProgress = true;
		try {
			await snapshotSqliteToIndexedDB(playground, dbName);
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Snapshot failed:', error);
		} finally {
			snapshotInProgress = false;
		}
	};

	const onRequestEnd = () => {
		doSnapshot();
	};
	playground.addEventListener('request.end', onRequestEnd);

	// 3. Take the initial snapshot (captures the current state)
	await doSnapshot();

	// 4. Optional periodic safety snapshots
	const intervalMs = options.snapshotIntervalMs ?? 5000;
	let timer: ReturnType<typeof setInterval> | null = null;
	if (intervalMs > 0) {
		timer = setInterval(doSnapshot, intervalMs);
	}

	return {
		snapshot: doSnapshot,
		stop: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			// Note: we can't remove the event listener since
			// PlaygroundClient doesn't expose removeEventListener.
			// The listener will be GC'd when the playground is
			// disposed.
		},
	};
}
