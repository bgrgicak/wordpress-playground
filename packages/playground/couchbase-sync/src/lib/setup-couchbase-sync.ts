import type { PlaygroundClient } from '@wp-playground/remote';
import {
	installSqlSyncMuPlugin,
	setupPlaygroundSync,
} from '@wp-playground/sync';
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
import {
	snapshotSqlToPouchDB,
	snapshotFilesToPouchDB,
} from './snapshot-to-pouchdb';
import { getOrCreateOffset, getMaxSyncedIds } from './autoincrement-offset';

export interface CouchbaseSyncOptions {
	/**
	 * Configuration for the local Couchbase Lite database.
	 */
	database: {
		name: string;
		tablePrefix?: string;
	};

	/**
	 * Whether to restore state from the persisted PouchDB data
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
	 * Optional remote CouchDB / PouchDB Server configuration.
	 * When provided, the local PouchDB database will replicate
	 * with the remote server, enabling multi-device collaboration.
	 */
	remote?: CouchbaseReplicatorConfig;
}

export interface CouchbaseSyncHandle {
	database: CouchbaseDatabase;
	transport: CouchbaseSyncTransport;
	replicator: CouchbaseReplicatorManager | null;
	stop: () => void;
}

/**
 * Sets up real-time, row-level sync between a WordPress Playground
 * instance and PouchDB.
 *
 * ## First save vs. return visit
 *
 * On **first save** (no existing data in PouchDB):
 *   1. Snapshots ALL existing database rows into PouchDB
 *   2. Snapshots ALL wp-content files into PouchDB
 *   3. Sets up ongoing journaling for future changes
 *
 * On **return visit** (existing data in PouchDB):
 *   1. Restores all database rows from PouchDB → WASM SQLite
 *   2. Restores all wp-content files from PouchDB → WASM filesystem
 *   3. Sets up ongoing journaling for future changes
 *
 * ## Architecture
 *
 * ```
 * WordPress (WASM)
 *   ↕ SQL journal + FS journal
 *       ↓
 * CouchbaseSyncTransport
 *   ↕ row-level document operations
 *       ↓
 * PouchDB (IndexedDB) — local persistence
 *       ↓
 * CouchDB replication — remote sync (optional)
 * ```
 */
export async function setupCouchbaseSync(
	playground: PlaygroundClient,
	options: CouchbaseSyncOptions
): Promise<CouchbaseSyncHandle> {
	// 1. Open the local PouchDB database
	const cbDb = new CouchbaseDatabase({
		name: options.database.name,
		tablePrefix: options.database.tablePrefix,
	});
	await cbDb.open();

	const hasData = await hasCouchbaseData(cbDb);

	// Install the mu-plugin early — restoreFromCouchbase() needs
	// playground_sync_replay_sql_journal() which it defines.
	await installSqlSyncMuPlugin(playground);

	if (options.restoreOnBoot !== false && hasData) {
		// 2a. Return visit: restore from PouchDB
		const { sqlCount, fileCount } = await restoreFromCouchbase(
			playground,
			cbDb
		);
		// eslint-disable-next-line no-console
		console.log(
			`[CouchbaseSync] Restored ${sqlCount} SQL entries and ${fileCount} files.`
		);
	} else if (!hasData) {
		// 2b. First save: snapshot the full current state into PouchDB
		const [sqlCount, fileCount] = await Promise.all([
			snapshotSqlToPouchDB(playground, cbDb),
			snapshotFilesToPouchDB(playground, cbDb),
		]);
		// eslint-disable-next-line no-console
		console.log(
			`[CouchbaseSync] Initial snapshot: ${sqlCount} rows, ${fileCount} files.`
		);
	}

	// 3. Set up the real-time sync pipeline for ongoing changes.
	//    The transport starts PAUSED so that setup artifacts
	//    (mu-plugin install, autoincrement override) don't get
	//    sent to PouchDB and corrupt the saved state.
	const offset =
		options.autoincrementOffset ?? (await getOrCreateOffset(cbDb));
	const knownIds = await getMaxSyncedIds(cbDb);

	const transport = new CouchbaseSyncTransport(cbDb);
	transport.pause();

	await setupPlaygroundSync(playground, {
		autoincrementOffset: offset,
		transport,
		knownIds,
	});

	// Resume transport AFTER setup completes — only real user
	// changes will flow to PouchDB from this point on.
	transport.resume();

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
