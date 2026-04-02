// Dynamic import wrapper — resolved at runtime to avoid Vite/Rollup
// issues with PouchDB's module format during static analysis.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PouchDB: any;
const pouchdbReady = (async () => {
	try {
		// Browser: use pouchdb-browser (no Node.js builtins)
		const mod = await import('pouchdb-browser');
		PouchDB = mod.default || mod;
	} catch {
		// Node.js (tests): fall back to pouchdb
		const mod = await import('pouchdb');
		PouchDB = mod.default || mod;
	}
})();
import type {
	CouchbaseSaveOp,
	CouchbaseUpdateOp,
	CouchbaseDeleteOp,
	CouchbaseDocumentOp,
} from './sql-to-couchbase';
import type { CouchbaseDocChange } from './couchbase-to-sql';

/**
 * Known WordPress core tables. Used for listing purposes —
 * PouchDB doesn't need upfront schema definitions.
 */
const WP_CORE_TABLES = [
	'wp_posts',
	'wp_postmeta',
	'wp_comments',
	'wp_commentmeta',
	'wp_terms',
	'wp_term_taxonomy',
	'wp_term_relationships',
	'wp_options',
	'wp_users',
	'wp_usermeta',
	'wp_links',
];

/**
 * Document ID prefix for filesystem entries. Each file is stored
 * as a document with `wp_files::{relativePath}` as its _id.
 */
export const WP_FILES_COLLECTION = 'wp_files';

export interface CouchbaseDatabaseConfig {
	name: string;
	tablePrefix?: string;
	/** PouchDB adapter name. Use 'memory' for tests. */
	adapter?: string;
}

type ChangeCallback = (change: CouchbaseDocChange) => void;

/**
 * Manages a PouchDB database that mirrors WordPress data.
 * Each WordPress table maps to a document ID prefix (virtual
 * collection), and each row maps to a document.
 *
 * PouchDB provides:
 * - IndexedDB storage in the browser (offline-first)
 * - LevelDB storage in Node.js
 * - Built-in CouchDB replication protocol
 * - Document-level conflict resolution
 */
export class CouchbaseDatabase {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private db: any = null;
	private changeCallbacks: ChangeCallback[] = [];
	private knownCollections: Set<string> = new Set();
	private config: CouchbaseDatabaseConfig;
	private suppressChangeEvents = false;
	private opened = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private changesListener: any = null;

	constructor(config: CouchbaseDatabaseConfig) {
		this.config = config;
	}

	async open(): Promise<void> {
		await pouchdbReady;
		const tablePrefix = this.config.tablePrefix ?? 'wp_';
		for (const table of WP_CORE_TABLES) {
			const name = table.startsWith('wp_')
				? tablePrefix + table.slice(3)
				: table;
			this.knownCollections.add(name);
		}
		this.knownCollections.add(WP_FILES_COLLECTION);

		const pouchOpts = this.config.adapter
			? { adapter: this.config.adapter }
			: {};
		this.db = new PouchDB(this.config.name, pouchOpts);
		this.opened = true;

		// Live change feed — routes changes to callbacks
		this.changesListener = this.db
			.changes({
				live: true,
				since: 'now',
				include_docs: true,
			})
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.on('change', (change: any) => {
				if (this.suppressChangeEvents) {
					return;
				}
				const docChange = pouchChangeToCouchbaseChange(change);
				if (docChange) {
					for (const cb of this.changeCallbacks) {
						cb(docChange);
					}
				}
			});
	}

	async close(): Promise<void> {
		if (this.changesListener) {
			this.changesListener.cancel();
			this.changesListener = null;
		}
		if (this.db) {
			await this.db.close();
			this.db = null;
		}
		this.opened = false;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getDatabase(): any {
		return this.db;
	}

	isOpen(): boolean {
		return this.opened;
	}

	onDocumentChange(callback: ChangeCallback): void {
		this.changeCallbacks.push(callback);
	}

	async applyCouchbaseOps(ops: CouchbaseDocumentOp[]): Promise<void> {
		this.suppressChangeEvents = true;
		try {
			for (const op of ops) {
				switch (op.type) {
					case 'save':
						await this.applySave(op);
						break;
					case 'update':
						await this.applyUpdate(op);
						break;
					case 'delete':
						await this.applyDelete(op);
						break;
				}
			}
		} finally {
			this.suppressChangeEvents = false;
		}
	}

	async getAllDocuments(
		collectionName: string
	): Promise<CouchbaseDocChange[]> {
		const db = this.requireDb();
		const result = await db.allDocs({
			startkey: `${collectionName}::`,
			endkey: `${collectionName}::\ufff0`,
			include_docs: true,
		});

		return (
			result.rows
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.filter((row: any) => !row.doc._deleted)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map((row: any) => {
					const body = fromPouchBody(row.doc);
					const collection = parseCollection(row.id);
					return {
						collection: collection ?? collectionName,
						docId: row.id,
						deleted: false,
						body,
					};
				})
		);
	}

	getCollectionNames(): string[] {
		return Array.from(this.knownCollections);
	}

	getDataCollectionNames(): string[] {
		return Array.from(this.knownCollections).filter(
			(n) => n !== WP_FILES_COLLECTION
		);
	}

	async saveFile(path: string, data: string): Promise<void> {
		const db = this.requireDb();
		const id = `${WP_FILES_COLLECTION}::${path}`;
		const body = { meta_path: path, data };

		this.suppressChangeEvents = true;
		try {
			await putDoc(db, id, body);
		} finally {
			this.suppressChangeEvents = false;
		}
	}

	async deleteFile(path: string): Promise<void> {
		const db = this.requireDb();
		const id = `${WP_FILES_COLLECTION}::${path}`;

		this.suppressChangeEvents = true;
		try {
			await removeDoc(db, id);
		} finally {
			this.suppressChangeEvents = false;
		}
	}

	async getAllFiles(): Promise<Array<{ path: string; data: string }>> {
		const db = this.requireDb();
		const result = await db.allDocs({
			startkey: `${WP_FILES_COLLECTION}::`,
			endkey: `${WP_FILES_COLLECTION}::\ufff0`,
			include_docs: true,
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return result.rows.map((row: any) => ({
			path:
				(row.doc.meta_path as string) ??
				row.id.slice(`${WP_FILES_COLLECTION}::`.length),
			data: row.doc.data as string,
		}));
	}

	private async applySave(op: CouchbaseSaveOp): Promise<void> {
		const db = this.requireDb();
		const id = op.docId;
		this.ensureCollection(op.collection);
		await putDoc(db, id, op.body);
	}

	private async applyUpdate(op: CouchbaseUpdateOp): Promise<void> {
		if (!op.docId) {
			// eslint-disable-next-line no-console
			console.warn(
				'[CouchbaseSync] Skipping UPDATE with null docId:',
				op.collection,
				op.query?.substring(0, 100)
			);
			return;
		}
		if (Object.keys(op.fields).length === 0) {
			return;
		}
		const db = this.requireDb();
		this.ensureCollection(op.collection);

		try {
			const existing = await db.get(op.docId);
			for (const [key, value] of Object.entries(op.fields)) {
				existing[key] = value;
			}
			await db.put(existing);
		} catch (e: unknown) {
			if ((e as { status?: number }).status !== 404) {
				throw e;
			}
		}
	}

	private async applyDelete(op: CouchbaseDeleteOp): Promise<void> {
		if (!op.docId) {
			// eslint-disable-next-line no-console
			console.warn(
				'[CouchbaseSync] Skipping DELETE with null docId:',
				op.collection,
				op.query?.substring(0, 100)
			);
			return;
		}
		const db = this.requireDb();
		this.ensureCollection(op.collection);
		await removeDoc(db, op.docId);
	}

	private ensureCollection(name: string): void {
		this.knownCollections.add(name);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private requireDb(): any {
		if (!this.db || !this.opened) {
			throw new Error(
				'CouchbaseDatabase is not open. Call open() first.'
			);
		}
		return this.db;
	}
}

// ── PouchDB helpers ─────────────────────────────────────────

/**
 * Put a document, handling create vs update (fetching _rev).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function putDoc(db: any, id: string, body: Record<string, unknown>) {
	const doc: Record<string, unknown> = { _id: id, ...body };
	try {
		const existing = await db.get(id);
		doc._rev = existing._rev;
	} catch (e: unknown) {
		if ((e as { status?: number }).status !== 404) {
			throw e;
		}
	}
	await db.put(doc);
}

/**
 * Remove a document by ID, ignoring 404.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function removeDoc(db: any, id: string) {
	try {
		const existing = await db.get(id);
		await db.remove(existing);
	} catch (e: unknown) {
		if ((e as { status?: number }).status !== 404) {
			throw e;
		}
	}
}

/**
 * Extracts the collection name from a PouchDB document _id.
 * IDs follow the pattern "collection::docId".
 */
function parseCollection(id: string): string | null {
	const idx = id.indexOf('::');
	return idx === -1 ? null : id.slice(0, idx);
}

/**
 * Converts a PouchDB change event to a CouchbaseDocChange.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pouchChangeToCouchbaseChange(change: any): CouchbaseDocChange | null {
	const id: string = change.id;
	const collection = parseCollection(id);
	if (!collection) {
		return null;
	}

	if (change.deleted) {
		return {
			collection,
			docId: id,
			deleted: true,
			body: null,
		};
	}

	const body = change.doc ? fromPouchBody(change.doc) : null;
	return {
		collection,
		docId: id,
		deleted: false,
		body,
	};
}

/**
 * Strips PouchDB internal fields (_id, _rev) from a document
 * body for use in the Couchbase conversion layer.
 */
function fromPouchBody(doc: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(doc)) {
		if (key === '_id' || key === '_rev') {
			continue;
		}
		body[key] = value;
	}
	return body;
}
