import type { SQLJournalEntry } from '@wp-playground/sync';

/**
 * Represents a document change received from Couchbase Lite,
 * either from the local change listener or from a remote
 * replicator pull.
 */
export interface CouchbaseDocChange {
	collection: string;
	docId: string;
	deleted: boolean;
	body: Record<string, unknown> | null;
}

/**
 * Converts a Couchbase document change into a SQL journal entry
 * that can be replayed on the SQLite database inside PHP-WASM.
 *
 * For inserts/updates, we generate a REPLACE INTO statement which
 * works as an upsert in SQLite. For deletes, we generate a DELETE
 * FROM statement keyed on the primary key.
 */
export function couchbaseChangeToSqlJournalEntry(
	change: CouchbaseDocChange
): SQLJournalEntry | null {
	if (!change.body && !change.deleted) {
		return null;
	}

	const tableName = (change.body?.meta_table as string) ?? change.collection;
	const pkColumn = (change.body?.meta_pk_column as string) || 'id';

	if (change.deleted) {
		const pkValue = extractPkFromDocId(change.docId);
		if (pkValue === null) {
			return null;
		}
		return {
			type: 'sql',
			subtype: 'replay-query',
			query: `DELETE FROM \`${escSql(tableName)}\` WHERE \`${escSql(pkColumn)}\` = ${quoteSqlValue(pkValue)}`,
			query_type: 'DELETE',
			table_name: tableName,
			auto_increment_column: pkColumn,
			last_insert_id: 0,
		};
	}

	const body = change.body!;
	const columns: string[] = [];
	const values: string[] = [];

	const SKIP_FIELDS = new Set([
		'meta_table',
		'meta_pk_column',
		'meta_path',
		'collection',
		'docId',
		'_id',
		'_rev',
		'_deleted',
		'_attachments',
	]);
	for (const [key, value] of Object.entries(body)) {
		// Skip internal metadata and PouchDB fields
		if (SKIP_FIELDS.has(key) || key.startsWith('_')) {
			continue;
		}
		columns.push(`\`${escSql(key)}\``);
		values.push(quoteSqlValue(value));
	}

	if (columns.length === 0) {
		return null;
	}

	const query =
		`REPLACE INTO \`${escSql(tableName)}\` (${columns.join(', ')}) ` +
		`VALUES (${values.join(', ')})`;

	const pkValue = body[pkColumn];
	const lastInsertId =
		typeof pkValue === 'number' ? pkValue : Number(pkValue) || 0;

	return {
		type: 'sql',
		subtype: 'replay-query',
		query,
		query_type: 'INSERT',
		table_name: tableName,
		auto_increment_column: pkColumn,
		last_insert_id: lastInsertId,
	};
}

/**
 * Extracts the primary key value from a Couchbase document ID.
 * Document IDs follow the pattern "tablename::pkvalue".
 */
function extractPkFromDocId(docId: string): string | number | null {
	const separatorIdx = docId.indexOf('::');
	if (separatorIdx === -1) {
		return null;
	}
	const raw = docId.slice(separatorIdx + 2);
	const num = Number(raw);
	return isNaN(num) ? raw : num;
}

function escSql(value: string): string {
	return value.replace(/`/g, '``');
}

function quoteSqlValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'number') {
		return String(value);
	}
	if (typeof value === 'boolean') {
		return value ? '1' : '0';
	}
	const str = String(value);
	return `'${str.replace(/'/g, "''")}'`;
}
