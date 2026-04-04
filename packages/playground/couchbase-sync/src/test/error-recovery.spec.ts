import { CouchbaseDatabase } from '../lib/couchbase-database';
import {
	CouchbaseReplicatorManager,
	type ReplicationStatus,
	type CouchbaseReplicatorConfig,
} from '../lib/couchbase-replicator';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PouchDB = require('pouchdb');
// eslint-disable-next-line @typescript-eslint/no-require-imports
PouchDB.plugin(require('pouchdb-adapter-memory'));

describe('CouchbaseReplicatorManager - Error recovery & lifecycle', () => {
	let cbDb: CouchbaseDatabase;

	beforeEach(async () => {
		cbDb = new CouchbaseDatabase({
			name: `recovery-test-${Date.now()}`,
			adapter: 'memory',
		});
		await cbDb.open();
	});

	afterEach(async () => {
		await cbDb.close();
	});

	it('status starts as idle, becomes stopped after stop()', () => {
		const config: CouchbaseReplicatorConfig = {
			url: 'http://localhost:5984/testdb',
		};

		const manager = new CouchbaseReplicatorManager(cbDb, config);
		expect(manager.status).toBe('idle');

		// Calling stop() without having started should still
		// transition to 'stopped' cleanly (no-op on cancel).
		manager.stop();
		expect(manager.status).toBe('stopped');
	});

	it(
		'restart() calls stop then start',
		async () => {
			// Create a mock-like CouchbaseDatabase that tracks calls.
			// Since start() requires a real PouchDB remote URL, we
			// test that restart() properly stops first by checking
			// status transitions and catching the expected start error.
			const statuses: ReplicationStatus[] = [];
			const config: CouchbaseReplicatorConfig = {
				url: 'http://localhost:5984/testdb',
				onStatusChange: (status) => {
					statuses.push(status);
				},
			};

			const manager = new CouchbaseReplicatorManager(cbDb, config);
			expect(manager.status).toBe('idle');

			// restart() calls stop() then start(). start() will
			// attempt to connect to the remote URL, which will fail
			// in a test environment. We verify stop() was called by
			// checking the status includes 'stopped', and start()
			// was attempted by catching the resulting error or
			// verifying 'active' is set before the network call fails.
			try {
				await manager.restart();
			} catch {
				// Expected: PouchDB cannot reach the remote URL
			}

			// stop() should have been called, setting 'stopped'
			expect(statuses).toContain('stopped');
			// After stop+start, status should have progressed
			// past 'stopped' (start sets 'active' before network)
			expect(statuses).toContain('active');
		},
		{ timeout: 10_000 }
	);

	it('onStatusChange callback fires on status transitions', () => {
		const statuses: ReplicationStatus[] = [];
		const config: CouchbaseReplicatorConfig = {
			url: 'http://localhost:5984/testdb',
			onStatusChange: (status) => {
				statuses.push(status);
			},
		};

		const manager = new CouchbaseReplicatorManager(cbDb, config);
		expect(statuses).toEqual([]);

		// stop() triggers onStatusChange('stopped')
		manager.stop();
		expect(statuses).toEqual(['stopped']);
		expect(manager.status).toBe('stopped');

		// Calling stop() again should fire the callback again
		manager.stop();
		expect(statuses).toEqual(['stopped', 'stopped']);
	});

	it(
		'stop() cancels active replication and sets stopped status',
		async () => {
			const statuses: ReplicationStatus[] = [];
			const config: CouchbaseReplicatorConfig = {
				url: 'http://localhost:5984/testdb',
				onStatusChange: (status) => {
					statuses.push(status);
				},
			};

			const manager = new CouchbaseReplicatorManager(cbDb, config);

			// Attempt to start (will set active before network fails)
			try {
				await manager.start();
			} catch {
				// Expected in test environment
			}

			// If start succeeded far enough to set active
			if (statuses.includes('active')) {
				manager.stop();
				expect(manager.status).toBe('stopped');
				expect(statuses[statuses.length - 1]).toBe('stopped');
				// The replicator handle should be cleared
				expect(manager.getReplicator()).toBeNull();
			}
		},
		{ timeout: 10_000 }
	);

	it('getReplicator() returns null before start', () => {
		const config: CouchbaseReplicatorConfig = {
			url: 'http://localhost:5984/testdb',
		};

		const manager = new CouchbaseReplicatorManager(cbDb, config);
		expect(manager.getReplicator()).toBeNull();
	});

	it('throws if database is not open when starting', async () => {
		const closedDb = new CouchbaseDatabase({
			name: `closed-test-${Date.now()}`,
			adapter: 'memory',
		});
		// Deliberately not calling closedDb.open()

		const config: CouchbaseReplicatorConfig = {
			url: 'http://localhost:5984/testdb',
		};

		const manager = new CouchbaseReplicatorManager(closedDb, config);
		await expect(manager.start()).rejects.toThrow(
			'CouchbaseDatabase must be open before starting replication.'
		);
	});
});
