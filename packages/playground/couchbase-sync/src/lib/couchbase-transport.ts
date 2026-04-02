import type {
	PlaygroundSyncTransport,
	TransportEnvelope,
	ChangesCallback,
} from '@wp-playground/sync';
import type { SQLJournalEntry } from '@wp-playground/sync';
import type { CouchbaseDatabase } from './couchbase-database';
import { sqlJournalEntryToCouchbaseOps } from './sql-to-couchbase';
import { couchbaseChangeToSqlJournalEntry } from './couchbase-to-sql';
import type { CouchbaseDocChange } from './couchbase-to-sql';

/**
 * A PlaygroundSyncTransport that bridges WordPress Playground's
 * existing sync infrastructure with Couchbase Lite.
 *
 * Outbound: SQL journal entries → Couchbase document operations.
 * Inbound: Couchbase document changes → SQL journal entries.
 *
 * This transport can be used as a drop-in replacement for
 * ParentWindowTransport or any other PlaygroundSyncTransport.
 */
export class CouchbaseSyncTransport implements PlaygroundSyncTransport {
	private cbDb: CouchbaseDatabase;
	private changesCallback: ChangesCallback | null = null;
	private pendingSqlEntries: SQLJournalEntry[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushIntervalMs: number;

	constructor(cbDb: CouchbaseDatabase, flushIntervalMs = 1000) {
		this.cbDb = cbDb;
		this.flushIntervalMs = flushIntervalMs;

		// Listen for changes coming from Couchbase (e.g. from
		// a remote replicator pull) and convert them to SQL
		// entries that the existing sync system can replay.
		this.cbDb.onDocumentChange((change: CouchbaseDocChange) => {
			const sqlEntry = couchbaseChangeToSqlJournalEntry(change);
			if (sqlEntry && this.changesCallback) {
				this.pendingSqlEntries.push(sqlEntry);
				this.scheduleFlush();
			}
		});
	}

	/**
	 * Called by the existing sync system when local SQL changes
	 * are ready to be sent. We convert them to Couchbase
	 * document operations and apply them to the local Couchbase
	 * Lite database.
	 */
	sendChanges(envelope: TransportEnvelope): void {
		if (!envelope.sql.length) {
			return;
		}

		const ops = envelope.sql.flatMap(sqlJournalEntryToCouchbaseOps);
		// Fire and forget - errors logged internally
		this.cbDb.applyCouchbaseOps(ops).catch((error) => {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Failed to apply ops:', error);
		});
	}

	/**
	 * Registers the callback that the existing sync system uses
	 * to receive inbound changes. Changes from the Couchbase
	 * side are batched and delivered through this callback.
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
			if (this.pendingSqlEntries.length && this.changesCallback) {
				const entries = this.pendingSqlEntries;
				this.pendingSqlEntries = [];
				this.changesCallback({
					fs: [],
					sql: entries,
				});
			}
		}, this.flushIntervalMs);
	}
}
