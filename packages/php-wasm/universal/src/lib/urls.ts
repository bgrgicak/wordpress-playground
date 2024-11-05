import { joinPaths } from '@php-wasm/util';

/**
 * The default base used to convert a path into the URL object.
 */
export const DEFAULT_BASE_URL = 'http://example.com';

/**
 * Returns a string representing the path, query, and
 * fragment of the given URL.
 *
 * @example
 * ```js
 * const url = new URL('http://example.com/foo/bar?baz=qux#quux');
 * toRelativeUrl(url); // '/foo/bar?baz=qux#quux'
 * ```
 *
 * @param  url The URL.
 * @returns The path, query, and fragment.
 */
export function toRelativeUrl(url: URL): string {
	return url.toString().substring(url.origin.length);
}

/**
 * Removes the given prefix from the given path.
 *
 * @example
 * ```js
 * removePathPrefix('/foo/bar', '/foo'); // '/bar'
 * removePathPrefix('/bar', '/foo'); // '/bar'
 * ```
 *
 * @param  path   The path to remove the prefix from.
 * @param  prefix The prefix to remove.
 * @returns Path with the prefix removed.
 */
export function removePathPrefix(path: string, prefix: string): string {
	if (!prefix || !path.startsWith(prefix)) {
		return path;
	}
	return path.substring(prefix.length);
}

/**
 * Ensures the given path has the given prefix.
 *
 * @example
 * ```js
 * ensurePathPrefix('/bar', '/foo'); // '/foo/bar'
 * ensurePathPrefix('/foo/bar', '/foo'); // '/foo/bar'
 * ```
 *
 * @param  path
 * @param  prefix
 * @returns Path with the prefix added.
 */
export function ensurePathPrefix(path: string, prefix: string): string {
	if (!prefix || path.startsWith(prefix)) {
		return path;
	}
	return prefix + path;
}

/**
 * Returns a absolute URL for the provided URL.
 *
 * If the provided URL is relative, it will be prepended with the base URL.
 * If a absolute URL is provided, it will return the provided URL and ignore
 * the base URL.
 *
 * @param  url     - The URL to convert to an absolute URL.
 * @param  baseUrl - The base URL to use to convert the relative URL to an absolute URL.
 * @returns The absolute URL.
 */
export function toAbsoluteUrl(url: string, baseUrl: URL): string {
	if (url.startsWith('http')) {
		return url;
	}

	/**
	 * Base URLs can have subfolders in case of multi-sites,
	 * or might include the Playground scope.
	 *
	 * To preserve the full base URL, we need to prefix the relative URL
	 * with the base URL pathname.
	 */
	return baseUrl.origin + joinPaths(baseUrl.pathname, url);
}
