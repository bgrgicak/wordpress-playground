import { describe, it, expect } from 'vitest';
import { couchbaseChangeToSqlJournalEntry } from './couchbase-to-sql';
import type { CouchbaseDocChange } from './couchbase-to-sql';

describe('couchbaseChangeToSqlJournalEntry', () => {
	it('converts a document save to a REPLACE INTO statement', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_posts',
			docId: 'wp_posts::42',
			deleted: false,
			body: {
				meta_table: 'wp_posts',
				meta_pk_column: 'ID',
				ID: 42,
				post_title: 'Hello World',
				post_status: 'publish',
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.query_type).toBe('INSERT');
		expect(entry!.table_name).toBe('wp_posts');
		expect(entry!.query).toContain('REPLACE INTO');
		expect(entry!.query).toContain('`ID`');
		expect(entry!.query).toContain('`post_title`');
		expect(entry!.query).toContain("'Hello World'");
		expect(entry!.query).toContain('42');
		expect(entry!.last_insert_id).toBe(42);
	});

	it('converts a document deletion to a DELETE FROM statement', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_posts',
			docId: 'wp_posts::42',
			deleted: true,
			body: {
				meta_table: 'wp_posts',
				meta_pk_column: 'ID',
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.query_type).toBe('DELETE');
		expect(entry!.query).toContain('DELETE FROM');
		expect(entry!.query).toContain('`wp_posts`');
		expect(entry!.query).toContain('42');
	});

	it('skips internal _-prefixed fields in REPLACE INTO', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_options',
			docId: 'wp_options::1',
			deleted: false,
			body: {
				meta_table: 'wp_options',
				meta_pk_column: 'option_id',
				option_id: 1,
				option_name: 'siteurl',
				option_value: 'http://localhost',
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.query).not.toContain('meta_table');
		expect(entry!.query).not.toContain('meta_pk_column');
		expect(entry!.query).toContain('`option_id`');
		expect(entry!.query).toContain('`option_name`');
	});

	it('returns null for changes with no body and not deleted', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_posts',
			docId: 'wp_posts::1',
			deleted: false,
			body: null,
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).toBeNull();
	});

	it('returns null for deletes with malformed doc ID', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_posts',
			docId: 'malformed-id',
			deleted: true,
			body: null,
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).toBeNull();
	});

	it('handles null values in document body', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_postmeta',
			docId: 'wp_postmeta::10',
			deleted: false,
			body: {
				meta_table: 'wp_postmeta',
				meta_pk_column: 'meta_id',
				meta_id: 10,
				post_id: 42,
				meta_key: '_edit_lock',
				meta_value: null,
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.query).toContain('NULL');
	});

	it('escapes single quotes in string values', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_posts',
			docId: 'wp_posts::1',
			deleted: false,
			body: {
				meta_table: 'wp_posts',
				meta_pk_column: 'ID',
				ID: 1,
				post_title: "It's a test",
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.query).toContain("'It''s a test'");
	});

	it('uses collection name as fallback table name', () => {
		const change: CouchbaseDocChange = {
			collection: 'wp_users',
			docId: 'wp_users::1',
			deleted: false,
			body: {
				user_login: 'admin',
				user_email: 'admin@example.com',
			},
		};

		const entry = couchbaseChangeToSqlJournalEntry(change);
		expect(entry).not.toBeNull();
		expect(entry!.table_name).toBe('wp_users');
	});
});
