import { Database, meta, LastWriteWins, DocID } from '@couchbase/lite-js';
import type { CollectionChange } from '@couchbase/lite-js';
import type {
	CouchbaseSaveOp,
	CouchbaseUpdateOp,
	CouchbaseDeleteOp,
	CouchbaseDocumentOp,
} from './sql-to-couchbase';
import type { CouchbaseDocChange } from './couchbase-to-sql';

/**
 * Known WordPress core tables that will be pre-created as
 * Couchbase collections. Additional collections are created
 * dynamically as new tables appear in SQL journal entries.
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

export interface CouchbaseDatabaseConfig {
	name: string;
	tablePrefix?: string;
}

type ChangeCallback = (change: CouchbaseDocChange) => void;

// We use dynamic collection names derived from WordPress tables,
// so we build the config object at runtime. Couchbase Lite JS's
// types are generic and schema-driven, but our usage is dynamic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDatabase = Database<any>;

/**
 * Manages a Couchbase Lite database that mirrors WordPress
 * SQLite data. Each WordPress table maps to a Couchbase
 * collection, and each row maps to a document.
 */
export class CouchbaseDatabase {
	private db: AnyDatabase | null = null;
	private changeCallbacks: ChangeCallback[] = [];
	private knownCollections: Set<string> = new Set();
	private listeningCollections: Set<string> = new Set();
	private config: CouchbaseDatabaseConfig;
	private suppressChangeEvents = false;

	constructor(config: CouchbaseDatabaseConfig) {
		this.config = config;
	}

	async open(): Promise<void> {
		const tablePrefix = this.config.tablePrefix ?? 'wp_';
		const collections: Record<string, object> = {};

		for (const table of WP_CORE_TABLES) {
			const name = table.startsWith('wp_')
				? tablePrefix + table.slice(3)
				: table;
			collections[name] = {};
			this.knownCollections.add(name);
		}

		this.db = await Database.open({
			name: this.config.name,
			version: 1,
			collections,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);

		for (const collectionName of this.knownCollections) {
			this.addCollectionChangeListener(collectionName);
		}
	}

	async close(): Promise<void> {
		if (this.db) {
			await this.db.close();
			this.db = null;
		}
	}

	getDatabase(): AnyDatabase | null {
		return this.db;
	}

	isOpen(): boolean {
		return this.db?.isOpen ?? false;
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
		const collection = db.getCollection(collectionName);
		if (!collection) {
			return [];
		}

		const changes: CouchbaseDocChange[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await collection.eachDocument((doc: any) => {
			const docMeta = meta(doc);
			const body: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(doc)) {
				if (typeof key === 'string') {
					body[key] = value;
				}
			}
			changes.push({
				collection: collectionName,
				docId: docMeta.id as string,
				deleted: false,
				body,
			});
			return true;
		});
		return changes;
	}

	getCollectionNames(): string[] {
		return Array.from(this.knownCollections);
	}

	private async applySave(op: CouchbaseSaveOp): Promise<void> {
		const db = this.requireDb();
		await this.ensureCollection(op.collection);
		const collection = db.getCollection(op.collection);
		if (!collection) {
			return;
		}

		const docId = DocID(op.docId);
		const existing = await collection.getDocument(docId);
		if (existing) {
			const docMeta = meta(existing);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			docMeta.setBody(op.body as any);
			await collection.save(existing, LastWriteWins);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const doc = collection.createDocument(docId, op.body as any);
			await collection.save(doc, LastWriteWins);
		}
	}

	private async applyUpdate(op: CouchbaseUpdateOp): Promise<void> {
		if (!op.docId || Object.keys(op.fields).length === 0) {
			return;
		}
		const db = this.requireDb();
		await this.ensureCollection(op.collection);
		const collection = db.getCollection(op.collection);
		if (!collection) {
			return;
		}

		const docId = DocID(op.docId);
		const existing = await collection.getDocument(docId);
		if (existing) {
			for (const [key, value] of Object.entries(op.fields)) {
				(existing as Record<string, unknown>)[key] = value;
			}
			await collection.save(existing, LastWriteWins);
		}
	}

	private async applyDelete(op: CouchbaseDeleteOp): Promise<void> {
		if (!op.docId) {
			return;
		}
		const db = this.requireDb();
		await this.ensureCollection(op.collection);
		const collection = db.getCollection(op.collection);
		if (!collection) {
			return;
		}

		const docId = DocID(op.docId);
		const existing = await collection.getDocument(docId);
		if (existing) {
			await collection.delete(existing);
		}
	}

	private async ensureCollection(name: string): Promise<void> {
		if (this.knownCollections.has(name)) {
			return;
		}

		this.knownCollections.add(name);

		if (this.db) {
			await this.db.close();
		}

		const collections: Record<string, object> = {};
		for (const collectionName of this.knownCollections) {
			collections[collectionName] = {};
		}

		this.db = await Database.open({
			name: this.config.name,
			version: this.knownCollections.size,
			collections,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);

		this.listeningCollections.clear();
		for (const collectionName of this.knownCollections) {
			this.addCollectionChangeListener(collectionName);
		}
	}

	private addCollectionChangeListener(collectionName: string): void {
		if (this.listeningCollections.has(collectionName)) {
			return;
		}
		this.listeningCollections.add(collectionName);

		const db = this.requireDb();
		const collection = db.getCollection(collectionName);
		if (!collection) {
			return;
		}

		collection.addChangeListener(async (changes: CollectionChange) => {
			if (this.suppressChangeEvents) {
				return;
			}

			for (const [docIdStr, change] of changes) {
				const docId = DocID(docIdStr as string);
				let body: Record<string, unknown> | null = null;

				if (!change.deleted) {
					const doc = await collection.getDocument(docId);
					if (doc) {
						body = {};
						for (const [key, value] of Object.entries(doc)) {
							if (typeof key === 'string') {
								body[key] = value;
							}
						}
					}
				}

				const docChange: CouchbaseDocChange = {
					collection: collectionName,
					docId: docIdStr as string,
					deleted: change.deleted ?? false,
					body,
				};

				for (const cb of this.changeCallbacks) {
					cb(docChange);
				}
			}
		});
	}

	private requireDb(): AnyDatabase {
		if (!this.db || !this.db.isOpen) {
			throw new Error(
				'CouchbaseDatabase is not open. Call open() first.'
			);
		}
		return this.db;
	}
}
