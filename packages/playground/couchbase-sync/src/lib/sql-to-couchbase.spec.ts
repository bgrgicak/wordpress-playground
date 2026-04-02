import { describe, it, expect } from 'vitest';
import { sqlJournalEntryToCouchbaseOps } from './sql-to-couchbase';
import type { SQLJournalEntry } from '@wp-playground/sync';

describe('sqlJournalEntryToCouchbaseOps', () => {
	describe('reconstruct-insert entries', () => {
		it('converts a reconstruct-insert entry to a save op', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'reconstruct-insert',
				query_type: 'INSERT',
				table_name: 'wp_posts',
				auto_increment_column: 'ID',
				last_insert_id: 42,
				row: {
					ID: 42,
					post_title: 'Hello World',
					post_status: 'publish',
					post_content: '<p>Test</p>',
				},
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops).toHaveLength(1);
			expect(ops[0]).toEqual({
				type: 'save',
				collection: 'wp_posts',
				docId: 'wp_posts::42',
				body: {
					meta_table: 'wp_posts',
					meta_pk_column: 'ID',
					ID: 42,
					post_title: 'Hello World',
					post_status: 'publish',
					post_content: '<p>Test</p>',
				},
			});
		});

		it('handles null values in rows', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'reconstruct-insert',
				query_type: 'INSERT',
				table_name: 'wp_options',
				auto_increment_column: 'option_id',
				last_insert_id: 1,
				row: {
					option_id: 1,
					option_name: 'siteurl',
					option_value: null,
				},
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops[0].type).toBe('save');
			const saveOp = ops[0] as { body: Record<string, unknown> };
			expect(saveOp.body.option_value).toBeNull();
		});
	});

	describe('replay-query INSERT entries', () => {
		it('parses an INSERT query', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'replay-query',
				query: "INSERT INTO `wp_options` (`option_name`, `option_value`) VALUES ('blogname', 'My Blog')",
				query_type: 'INSERT',
				table_name: 'wp_options',
				auto_increment_column: 'option_id',
				last_insert_id: 5,
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops).toHaveLength(1);
			expect(ops[0].type).toBe('save');
			const saveOp = ops[0] as {
				collection: string;
				docId: string;
				body: Record<string, unknown>;
			};
			expect(saveOp.collection).toBe('wp_options');
			expect(saveOp.docId).toBe('wp_options::5');
			expect(saveOp.body.option_name).toBe('blogname');
			expect(saveOp.body.option_value).toBe('My Blog');
		});
	});

	describe('replay-query UPDATE entries', () => {
		it('parses an UPDATE query', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'replay-query',
				query: "UPDATE `wp_posts` SET `post_title` = 'Updated Title', `post_status` = 'draft' WHERE `ID` = 42",
				query_type: 'UPDATE',
				table_name: 'wp_posts',
				auto_increment_column: 'ID',
				last_insert_id: 0,
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops).toHaveLength(1);
			expect(ops[0].type).toBe('update');
			const updateOp = ops[0] as {
				docId: string | null;
				fields: Record<string, unknown>;
			};
			expect(updateOp.docId).toBe('42');
			expect(updateOp.fields.post_title).toBe('Updated Title');
			expect(updateOp.fields.post_status).toBe('draft');
		});

		it('handles UPDATE with no extractable primary key', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'replay-query',
				query: "UPDATE `wp_posts` SET `post_status` = 'trash' WHERE `post_type` = 'revision'",
				query_type: 'UPDATE',
				table_name: 'wp_posts',
				auto_increment_column: 'ID',
				last_insert_id: 0,
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops[0].type).toBe('update');
			const updateOp = ops[0] as { docId: string | null };
			expect(updateOp.docId).toBeNull();
		});
	});

	describe('replay-query DELETE entries', () => {
		it('parses a DELETE query', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'replay-query',
				query: 'DELETE FROM `wp_posts` WHERE `ID` = 42',
				query_type: 'DELETE',
				table_name: 'wp_posts',
				auto_increment_column: 'ID',
				last_insert_id: 0,
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops).toHaveLength(1);
			expect(ops[0].type).toBe('delete');
			const deleteOp = ops[0] as { docId: string | null };
			expect(deleteOp.docId).toBe('42');
		});
	});

	describe('table name normalization', () => {
		it('removes backticks from table names', () => {
			const entry: SQLJournalEntry = {
				type: 'sql',
				subtype: 'reconstruct-insert',
				query_type: 'INSERT',
				table_name: '`wp_posts`',
				auto_increment_column: 'ID',
				last_insert_id: 1,
				row: { ID: 1, post_title: 'Test' },
			};

			const ops = sqlJournalEntryToCouchbaseOps(entry);
			expect(ops[0]).toHaveProperty('collection', 'wp_posts');
		});
	});
});
