import type { SQLJournalEntry } from '@wp-playground/sync';

/**
 * Represents a Couchbase document operation derived from a SQL change.
 */
export type CouchbaseDocumentOp =
	| CouchbaseSaveOp
	| CouchbaseDeleteOp
	| CouchbaseUpdateOp;

export interface CouchbaseSaveOp {
	type: 'save';
	collection: string;
	docId: string;
	body: Record<string, unknown>;
}

export interface CouchbaseUpdateOp {
	type: 'update';
	collection: string;
	docId: string | null;
	query: string;
	fields: Record<string, unknown>;
}

export interface CouchbaseDeleteOp {
	type: 'delete';
	collection: string;
	docId: string | null;
	query: string;
}

/**
 * Converts a SQL journal entry into one or more Couchbase document
 * operations. Each WordPress table maps to a Couchbase collection,
 * and each row maps to a document keyed by its primary key.
 */
export function sqlJournalEntryToCouchbaseOps(
	entry: SQLJournalEntry
): CouchbaseDocumentOp[] {
	if (!entry.table_name) {
		return [];
	}
	if (entry.subtype === 'reconstruct-insert') {
		return [reconstructInsertToSaveOp(entry)];
	}
	return [replayQueryToCouchbaseOp(entry)];
}

function reconstructInsertToSaveOp(
	entry: Extract<SQLJournalEntry, { subtype: 'reconstruct-insert' }>
): CouchbaseSaveOp {
	const tableName = normalizeTableName(entry.table_name);
	const pkColumn = entry.auto_increment_column;
	const pkValue = entry.row[pkColumn];
	const docId = `${tableName}::${pkValue}`;

	const body: Record<string, unknown> = {
		_table: tableName,
		_pk_column: pkColumn,
	};
	for (const [key, value] of Object.entries(entry.row)) {
		body[key] = value;
	}

	return { type: 'save', collection: tableName, docId, body };
}

function replayQueryToCouchbaseOp(
	entry: Extract<SQLJournalEntry, { subtype: 'replay-query' }>
): CouchbaseDocumentOp {
	const tableName = normalizeTableName(entry.table_name);
	const queryType = entry.query_type.toUpperCase();
	const query = entry.query;

	if (queryType === 'INSERT') {
		return parseInsertQuery(tableName, query, entry);
	}

	if (queryType === 'UPDATE') {
		return {
			type: 'update',
			collection: tableName,
			docId: extractPrimaryKeyFromWhere(
				query,
				entry.auto_increment_column
			),
			query,
			fields: extractSetClause(query),
		};
	}

	if (queryType === 'DELETE') {
		return {
			type: 'delete',
			collection: tableName,
			docId: extractPrimaryKeyFromWhere(
				query,
				entry.auto_increment_column
			),
			query,
		};
	}

	// DDL or other queries: pass through as update with
	// empty fields so the consumer can handle them
	return {
		type: 'update',
		collection: tableName,
		docId: null,
		query,
		fields: {},
	};
}

function parseInsertQuery(
	tableName: string,
	query: string,
	entry: Extract<SQLJournalEntry, { subtype: 'replay-query' }>
): CouchbaseSaveOp {
	const body: Record<string, unknown> = {
		_table: tableName,
		_pk_column: entry.auto_increment_column,
	};

	// Try to parse INSERT INTO table (col1, col2) VALUES (val1, val2)
	const columnsMatch = query.match(
		/INSERT\s+INTO\s+\S+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
	);
	if (columnsMatch) {
		const columns = columnsMatch[1]
			.split(',')
			.map((c) => c.trim().replace(/[`"]/g, ''));
		const values = splitSqlValues(columnsMatch[2]);
		for (let i = 0; i < columns.length; i++) {
			body[columns[i]] = parseSqlValue(values[i]?.trim());
		}
	}

	const pkColumn = entry.auto_increment_column;
	const pkValue = body[pkColumn] ?? entry.last_insert_id;
	if (pkValue != null) {
		body[pkColumn] = pkValue;
	}
	const docId = `${tableName}::${pkValue ?? entry.last_insert_id}`;

	return { type: 'save', collection: tableName, docId, body };
}

/**
 * Splits a SQL VALUES clause respecting quoted strings.
 */
function splitSqlValues(valuesStr: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuote = false;
	let quoteChar = '';
	let escaped = false;

	for (const ch of valuesStr) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			current += ch;
			escaped = true;
			continue;
		}
		if (!inQuote && (ch === "'" || ch === '"')) {
			inQuote = true;
			quoteChar = ch;
			current += ch;
			continue;
		}
		if (inQuote && ch === quoteChar) {
			inQuote = false;
			current += ch;
			continue;
		}
		if (!inQuote && ch === ',') {
			result.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	result.push(current);
	return result;
}

function parseSqlValue(val: string | undefined): unknown {
	if (val === undefined || val === 'NULL' || val === 'null') {
		return null;
	}
	// Quoted string
	if (
		(val.startsWith("'") && val.endsWith("'")) ||
		(val.startsWith('"') && val.endsWith('"'))
	) {
		return val.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
	}
	// Number
	const num = Number(val);
	if (!isNaN(num) && val !== '') {
		return num;
	}
	return val;
}

/**
 * Attempts to extract a primary key value from a WHERE clause.
 * E.g., "... WHERE id = 42" → "42"
 */
function extractPrimaryKeyFromWhere(
	query: string,
	pkColumn: string
): string | null {
	if (!pkColumn) {
		return null;
	}
	const escapedCol = pkColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(
		`WHERE\\s+[\\s\\S]*?(?:\`|"|)${escapedCol}(?:\`|"|)\\s*=\\s*('?)(\\d+|[^'\\s,)]+)\\1`,
		'i'
	);
	const match = query.match(pattern);
	return match ? match[2] : null;
}

/**
 * Extracts SET key=value pairs from an UPDATE query.
 */
function extractSetClause(query: string): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	const setMatch = query.match(/SET\s+([\s\S]+?)(?:\s+WHERE\s+|$)/i);
	if (!setMatch) {
		return fields;
	}

	const assignments = splitSqlValues(setMatch[1]);
	for (const assignment of assignments) {
		const eqIdx = assignment.indexOf('=');
		if (eqIdx === -1) {
			continue;
		}
		const key = assignment.slice(0, eqIdx).trim().replace(/[`"]/g, '');
		const value = assignment.slice(eqIdx + 1).trim();
		fields[key] = parseSqlValue(value);
	}
	return fields;
}

/**
 * Normalizes a WordPress table name for use as a Couchbase
 * collection name. Removes backticks and lowercases.
 */
function normalizeTableName(tableName: string): string {
	return tableName.replace(/[`"]/g, '').toLowerCase();
}
