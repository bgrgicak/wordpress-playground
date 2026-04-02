export {
	setupCouchbaseSync,
	type CouchbaseSyncOptions,
	type CouchbaseSyncHandle,
} from './lib/setup-couchbase-sync';

export {
	snapshotSqliteToIndexedDB,
	restoreSqliteFromIndexedDB,
	hasSqliteSnapshot,
} from './lib/sqlite-file-sync';

export {
	sqlJournalEntryToCouchbaseOps,
	type CouchbaseDocumentOp,
	type CouchbaseSaveOp,
	type CouchbaseUpdateOp,
	type CouchbaseDeleteOp,
} from './lib/sql-to-couchbase';

export {
	couchbaseChangeToSqlJournalEntry,
	type CouchbaseDocChange,
} from './lib/couchbase-to-sql';
