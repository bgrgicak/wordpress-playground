export {
	setupCouchbaseSync,
	type CouchbaseSyncOptions,
	type CouchbaseSyncHandle,
} from './lib/setup-couchbase-sync';

export {
	CouchbaseDatabase,
	WP_FILES_COLLECTION,
	type CouchbaseDatabaseConfig,
} from './lib/couchbase-database';

export { CouchbaseSyncTransport } from './lib/couchbase-transport';

export {
	CouchbaseReplicatorManager,
	type CouchbaseReplicatorConfig,
} from './lib/couchbase-replicator';

export {
	restoreFromCouchbase,
	hasCouchbaseData,
} from './lib/restore-from-couchbase';

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

export { applyFsOpsToCouchbase } from './lib/filesystem-to-couchbase';

export {
	couchbaseFileChangeToFsOp,
	isFileChange,
} from './lib/couchbase-to-filesystem';

export {
	snapshotSqlToPouchDB,
	snapshotFilesToPouchDB,
} from './lib/snapshot-to-pouchdb';

export { getOrCreateOffset, getMaxSyncedIds } from './lib/autoincrement-offset';
