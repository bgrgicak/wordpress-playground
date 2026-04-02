import type {
	PlaygroundSyncTransport,
	TransportEnvelope,
	ChangesCallback,
} from '@wp-playground/sync';
import type { FilesystemOperation } from '@php-wasm/fs-journal';
import type { SQLJournalEntry } from '@wp-playground/sync';
import type { CouchbaseDatabase } from './couchbase-database';
import { sqlJournalEntryToCouchbaseOps } from './sql-to-couchbase';
import { couchbaseChangeToSqlJournalEntry } from './couchbase-to-sql';
import { applyFsOpsToCouchbase } from './filesystem-to-couchbase';
import {
	couchbaseFileChangeToFsOp,
	isFileChange,
} from './couchbase-to-filesystem';
import type { CouchbaseDocChange } from './couchbase-to-sql';

/**
 * A PlaygroundSyncTransport that bridges WordPress Playground's
 * existing sync infrastructure with Couchbase Lite.
 *
 * Outbound:
 *   SQL journal entries → Couchbase document operations
 *   FS operations → Couchbase file documents (wp_files collection)
 *
 * Inbound (from replicator or local changes):
 *   Couchbase data doc changes → SQL journal entries
 *   Couchbase file doc changes → FilesystemOperation[]
 *
 * This transport can be used as a drop-in replacement for
 * ParentWindowTransport or any other PlaygroundSyncTransport.
 */
export class CouchbaseSyncTransport implements PlaygroundSyncTransport {
	private cbDb: CouchbaseDatabase;
	private changesCallback: ChangesCallback | null = null;
	private pendingSqlEntries: SQLJournalEntry[] = [];
	private pendingFsOps: FilesystemOperation[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushIntervalMs: number;
	private _paused = false;

	constructor(cbDb: CouchbaseDatabase, flushIntervalMs = 1000) {
		this.cbDb = cbDb;
		this.flushIntervalMs = flushIntervalMs;

		// Listen for changes coming from Couchbase (e.g. from
		// a remote replicator pull) and route them to either the
		// SQL or filesystem pipeline.
		this.cbDb.onDocumentChange((change: CouchbaseDocChange) => {
			if (!this.changesCallback) {
				return;
			}

			if (isFileChange(change)) {
				const fsOp = couchbaseFileChangeToFsOp(change);
				if (fsOp) {
					this.pendingFsOps.push(fsOp);
					this.scheduleFlush();
				}
			} else {
				const sqlEntry = couchbaseChangeToSqlJournalEntry(change);
				if (sqlEntry) {
					this.pendingSqlEntries.push(sqlEntry);
					this.scheduleFlush();
				}
			}
		});
	}

	/**
	 * Pause outbound sync. While paused, `sendChanges()` drops
	 * all changes. Used during restore/snapshot to prevent setup
	 * artifacts from poisoning PouchDB.
	 */
	pause(): void {
		this._paused = true;
	}

	/**
	 * Resume outbound sync after pause.
	 */
	resume(): void {
		this._paused = false;
	}

	/**
	 * Called by the sync system when local changes are ready to
	 * be sent. Converts SQL entries to Couchbase document ops
	 * and filesystem operations to file documents.
	 */
	sendChanges(envelope: TransportEnvelope): void {
		if (this._paused) {
			return;
		}
		// Handle SQL changes → Couchbase data documents
		if (envelope.sql.length) {
			const ops = envelope.sql.flatMap(sqlJournalEntryToCouchbaseOps);
			this.cbDb.applyCouchbaseOps(ops).catch((error) => {
				// eslint-disable-next-line no-console
				console.error(
					'[CouchbaseSync] Failed to apply SQL ops:',
					error
				);
			});
		}

		// Handle filesystem changes → Couchbase file documents
		if (envelope.fs.length) {
			applyFsOpsToCouchbase(this.cbDb, envelope.fs).catch((error) => {
				// eslint-disable-next-line no-console
				console.error('[CouchbaseSync] Failed to apply FS ops:', error);
			});
		}
	}

	/**
	 * Registers the callback that the sync system uses to receive
	 * inbound changes. Changes from the Couchbase side are batched
	 * and delivered through this callback.
	 */
	onChangesReceived(fn: ChangesCallback): void {
		this.changesCallback = fn;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			if (
				(this.pendingSqlEntries.length || this.pendingFsOps.length) &&
				this.changesCallback
			) {
				const sql = this.pendingSqlEntries;
				const fs = this.pendingFsOps;
				this.pendingSqlEntries = [];
				this.pendingFsOps = [];
				this.changesCallback({ fs, sql });
			}
		}, this.flushIntervalMs);
	}
}
