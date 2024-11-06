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
 * Checks if the given URL is an absolute URL.
 *
 * Absolute URLs start with `http://` or `https://`.
 *
 * @param  url - The URL string to check.
 * @returns True if the URL is absolute, false otherwise.
 */
export function isAbsoluteUrl(url: string): boolean {
	return url.startsWith('http://') || url.startsWith('https://');
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
	if (isAbsoluteUrl(url)) {
		return url;
	}

	/**
	 * Each Playground URL must have a scope to correctly resolve the current site.
	 *
	 * If a scope is provided in the relative URL, we need to preserve it.
	 *
	 * If the scope is not provided in the relative URL,
	 * we need to use the base URL pathname.
	 *
	 * We include the full base URL pathname in case it has subfolders in addition to the scope.
	 * Base URLs can have subfolders in multi-sites that use subfolders instead of subdomains.
	 */
	if (url.startsWith('/scope:')) {
		return baseUrl.origin + url;
	}
	return baseUrl.origin + joinPaths(baseUrl.pathname, url);
}
