import type { PlaygroundClient } from '@wp-playground/remote';
import {
	installSqlSyncMuPlugin,
	overrideAutoincrementSequences,
	replaySQLJournal,
} from '@wp-playground/sync';
import type { SQLJournalEntry } from '@wp-playground/sync';
import { phpVar } from '@php-wasm/util';
import { CouchbaseDatabase, WP_FILES_COLLECTION } from './couchbase-database';
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
	incrementalSnapshotSqlToPouchDB,
	primeSnapshotCacheFromPouchDB,
} from './snapshot-to-pouchdb';
import {
	getOrCreateOffset,
	getSavedSequence,
	saveSequence,
} from './autoincrement-offset';
import { couchbaseChangeToSqlJournalEntry } from './couchbase-to-sql';

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

	// 3. Apply autoincrement offset so each collaborating site
	//    generates primary keys in a different range, preventing
	//    PK collisions (and thus PouchDB doc ID collisions) when
	//    multiple sites sync to the same remote database.
	//    The offset is stored in PouchDB (_local/ doc, never
	//    replicated) and applied to WordPress on every boot.
	const offset = await getOrCreateOffset(cbDb);
	const savedSeq = await getSavedSequence(cbDb);
	await overrideAutoincrementSequences(playground, offset, savedSeq);
	// eslint-disable-next-line no-console
	console.log(
		`[CouchbaseSync] Autoincrement offset: ${offset}, savedSeq:`,
		JSON.stringify(savedSeq)
	);

	// 4. Set up two-tier periodic snapshot of the database to
	//    PouchDB. The real-time SQL journal pipeline requires
	//    onMessage callbacks from the PHP worker, which don't
	//    work for Service Worker-handled HTTP requests in the
	//    browser (Comlink serialization blocks message delivery).
	//
	//    Tier 1 (every 5s): Incremental — fetches COUNT + MAX(pk)
	//    per table in one PHP call. Only full-scans tables whose
	//    metadata changed. Cost: O(num_tables) when idle.
	//
	//    Tier 2 (every 60s): Full sweep — re-scans ALL tables to
	//    catch in-place UPDATEs that don't change count or max_pk.
	const SNAPSHOT_INTERVAL_MS = 5000;
	const FULL_SWEEP_EVERY_N = 12; // 12 × 5s = 60s
	let snapshotTimer: ReturnType<typeof setInterval> | null = null;
	let isSnapshotting = false;
	let snapshotCycleCount = 0;

	const SNAPSHOT_TIMEOUT_MS = 30000;

	const doSnapshot = async () => {
		snapshotCycleCount++;
		const forceFullSweep = snapshotCycleCount % FULL_SWEEP_EVERY_N === 0;
		const { tablesScanned } = await incrementalSnapshotSqlToPouchDB(
			playground,
			cbDb,
			forceFullSweep
		);
		await snapshotFilesToPouchDB(playground, cbDb);
		if (tablesScanned >= 0) {
			// eslint-disable-next-line no-console
			console.log(
				`[CouchbaseSync] Snapshot cycle ${snapshotCycleCount}:` +
					` ${tablesScanned} tables scanned` +
					(forceFullSweep ? ' (full sweep)' : '')
			);
		}
		// Persist playground_sequence values to PouchDB
		// (_local/ doc, not replicated) so they survive
		// page reloads.
		const seqResult = await playground.run({
			code: `<?php
			require '/wordpress/wp-load.php';
			$data = $GLOBALS['@pdo']
				->query('SELECT * FROM playground_sequence')
				->fetchAll(PDO::FETCH_KEY_PAIR);
			$intData = [];
			foreach ($data as $k => $v) { $intData[$k] = (int)$v; }
			echo json_encode($intData);
			`,
		});
		try {
			const seq = JSON.parse(new TextDecoder().decode(seqResult.bytes));
			await saveSequence(cbDb, seq);
		} catch {
			// Non-critical — sequence will be rebuilt on next boot
		}
		// Resolve any PouchDB conflicts that accumulated
		// from concurrent replication.
		const resolved = await cbDb.resolveConflicts();
		if (resolved > 0) {
			// eslint-disable-next-line no-console
			console.log(
				`[CouchbaseSync] Resolved ${resolved} PouchDB conflicts.`
			);
		}
	};

	const periodicSnapshot = async () => {
		if (isSnapshotting) {
			return;
		}
		isSnapshotting = true;
		try {
			await Promise.race([
				doSnapshot(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									'Snapshot timed out after ' +
										SNAPSHOT_TIMEOUT_MS +
										'ms'
								)
							),
						SNAPSHOT_TIMEOUT_MS
					)
				),
			]);
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Periodic snapshot failed:', e);
		} finally {
			isSnapshotting = false;
		}
	};

	snapshotTimer = setInterval(periodicSnapshot, SNAPSHOT_INTERVAL_MS);

	// 5. Optionally start remote replication
	let replicator: CouchbaseReplicatorManager | null = null;
	if (options.remote) {
		replicator = new CouchbaseReplicatorManager(cbDb, options.remote);
		await replicator.start();

		// 6. Live pull→replay: when documents arrive via
		//    replication, apply them to the local WordPress so
		//    the WASM instance stays in sync with the remote.
		const WP_CONTENT_PATH = '/wordpress/wp-content';
		const pendingSql: SQLJournalEntry[] = [];
		let replayTimer: ReturnType<typeof setTimeout> | null = null;
		let isReplaying = false;

		const flushPendingSql = async () => {
			replayTimer = null;
			if (isReplaying || pendingSql.length === 0) {
				return;
			}
			isReplaying = true;
			const batch = pendingSql.splice(0, pendingSql.length);
			try {
				await replaySQLJournal(playground, batch);
			} catch (e) {
				// eslint-disable-next-line no-console
				console.error('[CouchbaseSync] Live replay failed:', e);
			} finally {
				isReplaying = false;
				if (pendingSql.length > 0) {
					replayTimer = setTimeout(flushPendingSql, 200);
				}
			}
		};

		cbDb.onDocumentChange(async (change) => {
			if (change.collection === WP_FILES_COLLECTION) {
				// File change — write or delete in WASM filesystem
				if (change.body?.meta_path) {
					const relPath = change.body.meta_path as string;
					const absPath = `${WP_CONTENT_PATH}/${relPath}`;
					if (change.deleted) {
						try {
							await playground.unlink(absPath);
						} catch {
							// File may not exist locally
						}
					} else if (change.body.data) {
						const binary = atob(change.body.data as string);
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i++) {
							bytes[i] = binary.charCodeAt(i);
						}
						try {
							await playground.writeFile(absPath, bytes);
						} catch {
							// Directory may not exist
						}
					}
				}
				return;
			}

			// SQL data change — queue for batched replay
			const entry = couchbaseChangeToSqlJournalEntry(change);
			if (entry) {
				pendingSql.push(entry);
				if (!replayTimer) {
					replayTimer = setTimeout(flushPendingSql, 200);
				}
			}
		});
	}

	return {
		database: cbDb,
		replicator,
		stop: () => {
			if (snapshotTimer) {
				clearInterval(snapshotTimer);
			}
			if (replicator) {
				replicator.stop();
			}
			cbDb.close();
		},
	};
}
