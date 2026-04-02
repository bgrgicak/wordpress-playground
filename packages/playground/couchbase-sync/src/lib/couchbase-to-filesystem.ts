import type { FilesystemOperation } from '@php-wasm/fs-journal';
import type { CouchbaseDocChange } from './couchbase-to-sql';
import { WP_FILES_COLLECTION } from './couchbase-database';

/**
 * Converts a Couchbase document change from the wp_files
 * collection into a FilesystemOperation that can be replayed
 * on the WASM filesystem via replayFSJournal.
 *
 * Returns null if the change is not from the wp_files collection.
 */
export function couchbaseFileChangeToFsOp(
	change: CouchbaseDocChange
): FilesystemOperation | null {
	if (change.collection !== WP_FILES_COLLECTION) {
		return null;
	}

	const absPath = toAbsPath(change.docId);

	if (change.deleted) {
		return {
			operation: 'DELETE',
			path: absPath,
			nodeType: 'file',
		};
	}

	if (!change.body) {
		return null;
	}

	const base64Data = change.body.data as string;
	if (!base64Data) {
		// Empty file — emit CREATE
		return {
			operation: 'CREATE',
			path: absPath,
			nodeType: 'file',
		};
	}

	return {
		operation: 'WRITE',
		path: absPath,
		nodeType: 'file',
		data: base64ToUint8Array(base64Data),
	};
}

/**
 * Returns true if the change belongs to the wp_files collection.
 */
export function isFileChange(change: CouchbaseDocChange): boolean {
	return change.collection === WP_FILES_COLLECTION;
}

const WP_CONTENT_PREFIX = '/wordpress/wp-content/';

function toAbsPath(relativePath: string): string {
	if (relativePath.startsWith('/')) {
		return relativePath;
	}
	return WP_CONTENT_PREFIX + relativePath;
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
