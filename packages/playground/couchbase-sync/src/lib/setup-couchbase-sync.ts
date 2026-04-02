import type { PlaygroundClient } from '@wp-playground/remote';
import { setupPlaygroundSync } from '@wp-playground/sync';
import { CouchbaseDatabase } from './couchbase-database';
import { CouchbaseSyncTransport } from './couchbase-transport';
import {
	CouchbaseReplicatorManager,
	type CouchbaseReplicatorConfig,
} from './couchbase-replicator';
import {
	restoreFromCouchbase,
	hasCouchbaseData,
} from './restore-from-couchbase';

export interface CouchbaseSyncOptions {
	/**
	 * Configuration for the local Couchbase Lite database.
	 */
	database: {
		name: string;
		tablePrefix?: string;
	};

	/**
	 * Whether to restore state from the persisted Couchbase data
	 * on boot. When true, all previously synced rows and files are
	 * replayed into the WASM instance before ongoing sync starts.
	 *
	 * Default: true.
	 */
	restoreOnBoot?: boolean;

	/**
	 * Autoincrement offset for this client. Each collaborating
	 * Playground instance must use a different offset to avoid
	 * primary key collisions. Default: 1.
	 */
	autoincrementOffset?: number;

	/**
	 * Optional remote CouchDB / Sync Gateway configuration.
	 * When provided, the local Couchbase Lite database will
	 * replicate with the remote server, enabling multi-device
	 * collaboration.
	 */
	remote?: CouchbaseReplicatorConfig;
}

export interface CouchbaseSyncHandle {
	/**
	 * The local Couchbase Lite database instance. Useful for
	 * inspecting stored data or running queries.
	 */
	database: CouchbaseDatabase;

	/**
	 * The transport bridging the sync pipeline to Couchbase.
	 */
	transport: CouchbaseSyncTransport;

	/**
	 * The remote replicator, if configured.
	 */
	replicator: CouchbaseReplicatorManager | null;

	/**
	 * Stop all sync activity (local journaling + remote
	 * replication).
	 */
	stop: () => void;
}

/**
 * Sets up real-time, row-level sync between a WordPress Playground
 * instance and Couchbase Lite. Each WordPress table maps to a
 * Couchbase collection, and each row maps to a document. Filesystem
 * files (wp-content) are stored in a dedicated wp_files collection.
 *
 * ## Architecture
 *
 * ```
 * WordPress (WASM)
 *   ↕ SQL journal (INSERT/UPDATE/DELETE captured by mu-plugin)
 *   ↕ FS journal (file changes captured by Emscripten hooks)
 *       ↓
 * Sync Pipeline (middleware: prune, URL-marshall, hydrate)
 *       ↓
 * CouchbaseSyncTransport
 *   ↕ SQL entries ↔ Couchbase document ops
 *   ↕ FS ops ↔ Couchbase file documents
 *       ↓
 * Couchbase Lite (IndexedDB) — local persistence
 *       ↓
 * CouchbaseReplicator — remote sync (optional)
 *       ↓
 * CouchDB / Sync Gateway — collaboration server
 * ```
 *
 * ## Conflict Resolution
 *
 * - **Database rows**: Last-write-wins at the document level.
 *   Each row is a separate document, so concurrent edits to
 *   different rows never conflict. Same-row conflicts are
 *   resolved by accepting the remote version (configurable).
 *
 * - **Files**: Last-write-wins. Files are binary so merging
 *   isn't practical. The most recent write wins.
 */
export async function setupCouchbaseSync(
	playground: PlaygroundClient,
	options: CouchbaseSyncOptions
): Promise<CouchbaseSyncHandle> {
	// 1. Open the local Couchbase Lite database
	const cbDb = new CouchbaseDatabase({
		name: options.database.name,
		tablePrefix: options.database.tablePrefix,
	});
	await cbDb.open();

	// 2. Restore persisted data if this is a return visit
	if (options.restoreOnBoot !== false) {
		const hasData = await hasCouchbaseData(cbDb);
		if (hasData) {
			const { sqlCount, fileCount } = await restoreFromCouchbase(
				playground,
				cbDb
			);
			// eslint-disable-next-line no-console
			console.log(
				`[CouchbaseSync] Restored ${sqlCount} SQL entries and ${fileCount} files.`
			);
		}
	}

	// 3. Set up the real-time sync pipeline
	const transport = new CouchbaseSyncTransport(cbDb);
	await setupPlaygroundSync(playground, {
		autoincrementOffset: options.autoincrementOffset ?? 1,
		transport,
	});

	// 4. Optionally start remote replication
	let replicator: CouchbaseReplicatorManager | null = null;
	if (options.remote) {
		replicator = new CouchbaseReplicatorManager(cbDb, options.remote);
		await replicator.start();
	}

	return {
		database: cbDb,
		transport,
		replicator,
		stop: () => {
			if (replicator) {
				replicator.stop();
			}
			cbDb.close();
		},
	};
}
