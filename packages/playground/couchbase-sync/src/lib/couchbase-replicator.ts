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

export type ReplicationStatus =
	| 'idle'
	| 'active'
	| 'paused'
	| 'error'
	| 'stopped';

export interface CouchbaseReplicatorConfig {
	/** Remote CouchDB/PouchDB Server URL */
	url: string;
	credentials?: {
		username: string;
		password: string;
	};
	continuous?: boolean;
	direction?: 'push' | 'pull' | 'pushAndPull';
	onStatusChange?: (status: ReplicationStatus) => void;
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
	private _status: ReplicationStatus = 'idle';

	constructor(cbDb: CouchbaseDatabase, config: CouchbaseReplicatorConfig) {
		this.cbDb = cbDb;
		this.config = config;
	}

	get status(): ReplicationStatus {
		return this._status;
	}

	private setStatus(status: ReplicationStatus) {
		this._status = status;
		this.config.onStatusChange?.(status);
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

		// Ensure PouchDB replication fetch requests bypass the
		// Service Worker, which would otherwise intercept them
		// and route to the WASM PHP handler.
		installFetchBypass(new URL(remoteUrl).origin);

		const remoteDb = new PouchDB(remoteUrl);
		const opts = { live: continuous, retry: continuous };

		if (direction === 'push') {
			this.replication = localDb.replicate.to(remoteDb, opts);
		} else if (direction === 'pull') {
			this.replication = localDb.replicate.from(remoteDb, opts);
		} else {
			this.replication = localDb.sync(remoteDb, opts);
		}

		// eslint-disable-next-line no-console
		console.log(
			`[CouchbaseSync] Replication started: ${direction} → ${remoteUrl}`
		);

		this.setStatus('active');

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.replication.on('error', (error: any) => {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Replication error:', error);
			this.setStatus('error');
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.replication.on('change', (info: any) => {
			// eslint-disable-next-line no-console
			console.log(
				'[CouchbaseSync] Replication change:',
				info?.direction,
				info?.change?.docs_written ?? info?.docs_written ?? 0,
				'docs'
			);
			this.setStatus('active');
		});
		this.replication.on('paused', () => {
			// Paused = caught up with remote, waiting for changes
			this.setStatus('paused');
		});
		this.replication.on('active', () => {
			// Active = replication resumed after pause/reconnect
			this.setStatus('active');
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.replication.on('denied', (err: any) => {
			// eslint-disable-next-line no-console
			console.error('[CouchbaseSync] Replication denied:', err);
		});
	}

	async restart(): Promise<void> {
		this.stop();
		await this.start();
	}

	stop(): void {
		if (this.replication) {
			this.replication.cancel();
			this.replication = null;
		}
		this.setStatus('stopped');
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getReplicator(): any {
		return this.replication;
	}
}

/**
 * Patches window.fetch to add X-Playground-Bypass-SW header for
 * requests to the given origin. This is needed because the
 * Playground Service Worker intercepts all fetch requests from
 * controlled pages, including cross-origin PouchDB replication.
 *
 * Only installs the patch once per origin.
 */
const bypassedOrigins = new Set<string>();
function installFetchBypass(origin: string) {
	if (typeof window === 'undefined') {
		return;
	}
	if (bypassedOrigins.has(origin)) {
		return;
	}
	bypassedOrigins.add(origin);

	const originalFetch = window.fetch.bind(window);
	window.fetch = function patchedFetch(
		input: RequestInfo | URL,
		init?: RequestInit
	) {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		try {
			if (new URL(url, window.location.origin).origin === origin) {
				const headers = new Headers(init?.headers);
				headers.set('X-Playground-Bypass-SW', '1');
				return originalFetch(input, { ...init, headers });
			}
		} catch {
			// Invalid URL — pass through
		}
		return originalFetch(input, init);
	};
}
