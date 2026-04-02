import type { FilesystemOperation } from '@php-wasm/fs-journal';
import type { CouchbaseDatabase } from './couchbase-database';

/**
 * Applies filesystem operations to the Couchbase wp_files
 * collection. Each file is stored as a document with the
 * relative path as its ID and base64-encoded content.
 *
 * Operations:
 *   CREATE (file)  → save document (content filled later by
 *                     hydrateFsWrites middleware)
 *   WRITE          → save document with base64 content
 *   DELETE (file)  → delete document
 *   CREATE (dir)   → no-op (dirs are implicit in paths)
 *   DELETE (dir)   → delete all documents under that path
 *   RENAME         → delete old path, save at new path
 */
export async function applyFsOpsToCouchbase(
	cbDb: CouchbaseDatabase,
	ops: FilesystemOperation[]
): Promise<void> {
	for (const op of ops) {
		const path = normalizePath(op.path);

		switch (op.operation) {
			case 'CREATE':
				if (op.nodeType === 'file') {
					// File create without data — a WRITE will follow
					// with content. Save an empty placeholder so we
					// track the file's existence.
					await cbDb.saveFile(path, '');
				}
				// Directories are implicit — no document needed.
				break;

			case 'WRITE':
				if (op.data) {
					await cbDb.saveFile(path, uint8ArrayToBase64(op.data));
				}
				break;

			case 'DELETE':
				if (op.nodeType === 'directory') {
					// Delete all files under this directory
					const allFiles = await cbDb.getAllFiles();
					const dirPrefix = path.endsWith('/') ? path : path + '/';
					for (const file of allFiles) {
						if (file.path.startsWith(dirPrefix)) {
							await cbDb.deleteFile(file.path);
						}
					}
				} else {
					await cbDb.deleteFile(path);
				}
				break;

			case 'RENAME': {
				const toPath = normalizePath(op.toPath);
				if (op.nodeType === 'file') {
					// Read old, write new, delete old
					const allFiles = await cbDb.getAllFiles();
					const oldFile = allFiles.find((f) => f.path === path);
					if (oldFile) {
						await cbDb.saveFile(toPath, oldFile.data);
					}
					await cbDb.deleteFile(path);
				} else {
					// Rename directory: move all files under old path
					const allFiles = await cbDb.getAllFiles();
					const dirPrefix = path.endsWith('/') ? path : path + '/';
					for (const file of allFiles) {
						if (file.path.startsWith(dirPrefix)) {
							const newFilePath =
								toPath +
								'/' +
								file.path.slice(dirPrefix.length);
							await cbDb.saveFile(newFilePath, file.data);
							await cbDb.deleteFile(file.path);
						}
					}
				}
				break;
			}
		}
	}
}

/**
 * Strips the /wordpress/wp-content/ prefix to get a relative
 * path suitable for use as a Couchbase document ID.
 */
const WP_CONTENT_PREFIX = '/wordpress/wp-content/';

function normalizePath(absPath: string): string {
	if (absPath.startsWith(WP_CONTENT_PREFIX)) {
		return absPath.slice(WP_CONTENT_PREFIX.length);
	}
	return absPath;
}

function uint8ArrayToBase64(data: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < data.length; i++) {
		binary += String.fromCharCode(data[i]);
	}
	return btoa(binary);
}
