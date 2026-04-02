/**
 * Tests for the autoincrement offset strategy that prevents
 * ID collisions between collaborating sites.
 */
import { CouchbaseDatabase } from '../lib/couchbase-database';
import {
	getOrCreateOffset,
	getMaxSyncedIds,
} from '../lib/autoincrement-offset';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PouchDB = require('pouchdb');
// eslint-disable-next-line @typescript-eslint/no-require-imports
PouchDB.plugin(require('pouchdb-adapter-memory'));

describe('Autoincrement offset', () => {
	it('generates a large random offset on first call', async () => {
		const cbDb = new CouchbaseDatabase({
			adapter: 'memory',
			name: `offset-test-${Date.now()}`,
		});
		await cbDb.open();

		const offset = await getOrCreateOffset(cbDb);
		expect(offset).toBeGreaterThanOrEqual(1_000_000);
		expect(offset).toBeLessThanOrEqual(1_000_000_000);

		await cbDb.close();
	});

	it('returns the same offset on subsequent calls', async () => {
		const cbDb = new CouchbaseDatabase({
			adapter: 'memory',
			name: `offset-persist-${Date.now()}`,
		});
		await cbDb.open();

		const first = await getOrCreateOffset(cbDb);
		const second = await getOrCreateOffset(cbDb);
		expect(second).toBe(first);

		await cbDb.close();
	});

	it('different databases get different offsets', async () => {
		const dbA = new CouchbaseDatabase({
			adapter: 'memory',
			name: `offset-a-${Date.now()}`,
		});
		const dbB = new CouchbaseDatabase({
			adapter: 'memory',
			name: `offset-b-${Date.now()}`,
		});
		await dbA.open();
		await dbB.open();

		const offsetA = await getOrCreateOffset(dbA);
		const offsetB = await getOrCreateOffset(dbB);

		// Statistically very unlikely to be equal
		expect(offsetA).not.toBe(offsetB);

		await dbA.close();
		await dbB.close();
	});

	it('getMaxSyncedIds returns max PK values per table', async () => {
		const cbDb = new CouchbaseDatabase({
			adapter: 'memory',
			name: `maxids-test-${Date.now()}`,
		});
		await cbDb.open();

		// Simulate synced data from another site
		await cbDb.applyCouchbaseOps([
			{
				type: 'save',
				collection: 'wp_posts',
				docId: 'wp_posts::500000042',
				body: {
					meta_table: 'wp_posts',
					meta_pk_column: 'ID',
					ID: 500000042,
					post_title: 'Remote Post',
				},
			},
			{
				type: 'save',
				collection: 'wp_posts',
				docId: 'wp_posts::500000099',
				body: {
					meta_table: 'wp_posts',
					meta_pk_column: 'ID',
					ID: 500000099,
					post_title: 'Another Remote Post',
				},
			},
			{
				type: 'save',
				collection: 'wp_options',
				docId: 'wp_options::10',
				body: {
					meta_table: 'wp_options',
					meta_pk_column: 'option_id',
					option_id: 10,
					option_name: 'test',
				},
			},
		]);

		const maxIds = await getMaxSyncedIds(cbDb);
		expect(maxIds['wp_posts']).toBe(500000099);
		expect(maxIds['wp_options']).toBe(10);

		await cbDb.close();
	});

	it('two sites with random offsets produce non-overlapping IDs', async () => {
		const dbA = new CouchbaseDatabase({
			adapter: 'memory',
			name: `nonoverlap-a-${Date.now()}`,
		});
		const dbB = new CouchbaseDatabase({
			adapter: 'memory',
			name: `nonoverlap-b-${Date.now()}`,
		});
		await dbA.open();
		await dbB.open();

		const offsetA = await getOrCreateOffset(dbA);
		const offsetB = await getOrCreateOffset(dbB);

		// Simulate each site creating 100 posts
		const idsA = Array.from({ length: 100 }, (_, i) => offsetA + i + 1);
		const idsB = Array.from({ length: 100 }, (_, i) => offsetB + i + 1);

		// No overlap
		const setA = new Set(idsA);
		const overlap = idsB.filter((id) => setA.has(id));
		expect(overlap).toHaveLength(0);

		await dbA.close();
		await dbB.close();
	});

	it('knownIds ensures new IDs start above synced data', async () => {
		const cbDb = new CouchbaseDatabase({
			adapter: 'memory',
			name: `knownids-test-${Date.now()}`,
		});
		await cbDb.open();

		// Simulate synced posts from a remote site with high IDs
		await cbDb.applyCouchbaseOps([
			{
				type: 'save',
				collection: 'wp_posts',
				docId: 'wp_posts::999999',
				body: {
					meta_table: 'wp_posts',
					meta_pk_column: 'ID',
					ID: 999999,
					post_title: 'High ID Post',
				},
			},
		]);

		const offset = await getOrCreateOffset(cbDb);
		const maxIds = await getMaxSyncedIds(cbDb);

		// The offset should be large (random)
		expect(offset).toBeGreaterThanOrEqual(1_000_000);

		// maxIds should reflect the synced data
		expect(maxIds['wp_posts']).toBe(999999);

		// In production, setupPlaygroundSync passes both offset
		// and knownIds to overrideAutoincrementSequences. The PHP
		// code sets playground_sequence to max(offset, knownIds[table])
		// for each table. So new posts will get IDs > 999999.

		await cbDb.close();
	});
});
