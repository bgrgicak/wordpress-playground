import { Replicator } from '@couchbase/lite-js';
import type {
	Credentials,
	ReplicatorConfig,
	ReplicatorCollectionConfig,
} from '@couchbase/lite-js';
import type { CouchbaseDatabase } from './couchbase-database';

export interface CouchbaseReplicatorConfig {
	url: string;
	credentials?: Credentials;
	continuous?: boolean;
	collections?: string[];
	direction?: 'push' | 'pull' | 'pushAndPull';
}

/**
 * Wraps the Couchbase Lite JS Replicator to sync the local
 * Couchbase Lite database with a remote Couchbase Sync Gateway.
 *
 * This enables multi-device sync: SQLite changes flow into the
 * local Couchbase Lite database, which then replicates to the
 * Sync Gateway, and from there to other devices.
 */
export class CouchbaseReplicatorManager {
	private replicator: Replicator | null = null;
	private cbDb: CouchbaseDatabase;
	private config: CouchbaseReplicatorConfig;

	constructor(cbDb: CouchbaseDatabase, config: CouchbaseReplicatorConfig) {
		this.cbDb = cbDb;
		this.config = config;
	}

	async start(): Promise<void> {
		const db = this.cbDb.getDatabase();
		if (!db) {
			throw new Error(
				'CouchbaseDatabase must be open before starting replication.'
			);
		}

		const continuous = this.config.continuous ?? true;
		const direction = this.config.direction ?? 'pushAndPull';

		const collectionNames =
			this.config.collections ?? this.cbDb.getCollectionNames();
		const replicatorCollections: Record<
			string,
			ReplicatorCollectionConfig
		> = {};

		for (const name of collectionNames) {
			const collConfig: ReplicatorCollectionConfig = {};
			if (direction === 'push' || direction === 'pushAndPull') {
				collConfig.push = { continuous };
			}
			if (direction === 'pull' || direction === 'pushAndPull') {
				collConfig.pull = {
					continuous,
					conflictResolver: async (local, remote) => {
						// Default: last write wins
						if (!remote) {
							return local;
						}
						return remote;
					},
				};
			}
			replicatorCollections[name] = collConfig;
		}

		const replicatorConfig: ReplicatorConfig = {
			database: db,
			url: this.config.url,
			collections: replicatorCollections,
		};

		if (this.config.credentials) {
			replicatorConfig.credentials = this.config.credentials;
		}

		this.replicator = new Replicator(replicatorConfig);

		this.replicator.onStatusChange = (status) => {
			if (status.error) {
				// Log replication errors but don't throw since
				// the replicator will retry automatically in
				// continuous mode.
				// eslint-disable-next-line no-console
				console.error(
					'[CouchbaseSync] Replication error:',
					status.error
				);
			}
		};

		// Start the replicator - this returns a promise that
		// resolves when the replicator stops (for one-shot)
		// or runs indefinitely (for continuous)
		this.replicator.run().catch((error) => {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Replicator failed:', error);
		});
	}

	stop(): void {
		if (this.replicator) {
			this.replicator.stop();
			this.replicator = null;
		}
	}

	getReplicator(): Replicator | null {
		return this.replicator;
	}
}
