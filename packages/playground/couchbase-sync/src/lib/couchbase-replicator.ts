// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PouchDB: any;
const pouchdbReady = (async () => {
	try {
		const mod = await import('pouchdb-browser');
		PouchDB = mod.default || mod;
	} catch {
		const mod = await import('pouchdb');
		PouchDB = mod.default || mod;
	}
})();
import type { CouchbaseDatabase } from './couchbase-database';

export interface CouchbaseReplicatorConfig {
	/** Remote CouchDB/PouchDB Server URL */
	url: string;
	credentials?: {
		username: string;
		password: string;
	};
	continuous?: boolean;
	direction?: 'push' | 'pull' | 'pushAndPull';
}

/**
 * Manages PouchDB replication between the local database and a
 * remote CouchDB server. Uses the CouchDB replication protocol,
 * which supports:
 *
 * - Continuous (live) or one-shot sync
 * - Push, pull, or bidirectional
 * - Automatic conflict detection
 * - Offline-first with automatic retry
 */
export class CouchbaseReplicatorManager {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private replication: any = null;
	private cbDb: CouchbaseDatabase;
	private config: CouchbaseReplicatorConfig;

	constructor(cbDb: CouchbaseDatabase, config: CouchbaseReplicatorConfig) {
		this.cbDb = cbDb;
		this.config = config;
	}

	async start(): Promise<void> {
		await pouchdbReady;
		const localDb = this.cbDb.getDatabase();
		if (!localDb) {
			throw new Error(
				'CouchbaseDatabase must be open before starting replication.'
			);
		}

		const continuous = this.config.continuous ?? true;
		const direction = this.config.direction ?? 'pushAndPull';

		// Build the remote URL with optional auth
		let remoteUrl = this.config.url;
		if (this.config.credentials) {
			const { username, password } = this.config.credentials;
			const url = new URL(remoteUrl);
			url.username = username;
			url.password = password;
			remoteUrl = url.toString();
		}

		const remoteDb = new PouchDB(remoteUrl);
		const opts = { live: continuous, retry: continuous };

		if (direction === 'push') {
			this.replication = localDb.replicate.to(remoteDb, opts);
		} else if (direction === 'pull') {
			this.replication = localDb.replicate.from(remoteDb, opts);
		} else {
			this.replication = localDb.sync(remoteDb, opts);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.replication.on('error', (error: any) => {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Replication error:', error);
		});
	}

	stop(): void {
		if (this.replication) {
			this.replication.cancel();
			this.replication = null;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getReplicator(): any {
		return this.replication;
	}
}
