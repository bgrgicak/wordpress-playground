/**
 * Tests for the autoincrement offset strategy that prevents
 * ID collisions between collaborating sites.
 */
import { CouchbaseDatabase } from '../lib/couchbase-database';
import {
	getOrCreateOffset,
	getSavedSequence,
	saveSequence,
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

	it('saveSequence persists and getSavedSequence retrieves', async () => {
		const cbDb = new CouchbaseDatabase({
			adapter: 'memory',
			name: `seq-persist-${Date.now()}`,
		});
		await cbDb.open();

		// Initially empty
		const empty = await getSavedSequence(cbDb);
		expect(empty).toEqual({});

		// Save sequence values
		const seq = { wp_posts: 500000042, wp_options: 500000010 };
		await saveSequence(cbDb, seq);

		// Retrieve them
		const saved = await getSavedSequence(cbDb);
		expect(saved).toEqual(seq);

		// Update and re-retrieve
		const updated = { ...seq, wp_posts: 500000099 };
		await saveSequence(cbDb, updated);
		const reSaved = await getSavedSequence(cbDb);
		expect(reSaved).toEqual(updated);

		await cbDb.close();
	});
});
