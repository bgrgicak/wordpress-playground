import {
	getURLScope,
	isURLScoped,
	removeURLScope,
	setURLScope,
	appendPathnameToBaseUrlAndMaintainScope,
} from './index';

describe('getURLScope', () => {
	it('should return the scope from a scoped URL', () => {
		const url = new URL('http://localhost/scope:scope-12345/index.php');
		expect(getURLScope(url)).toBe('scope-12345');
	});

	it('should return null from a non-scoped URL', () => {
		const url = new URL('http://localhost/index.php');
		expect(getURLScope(url)).toBeNull();
	});
});

describe('isURLScoped', () => {
	it('should return true for a scoped URL', () => {
		const url = new URL('http://localhost/scope:12345/index.php');
		expect(isURLScoped(url)).toBe(true);
	});

	it('should return false for a non-scoped URL', () => {
		const url = new URL('http://localhost/index.php');
		expect(isURLScoped(url)).toBe(false);
	});
});

describe('removeURLScope', () => {
	it('should remove the scope from a scoped URL', () => {
		const url = new URL('http://localhost/scope:12345/index.php');
		expect(removeURLScope(url).href).toBe('http://localhost/index.php');
	});

	it('should return the same URL for a non-scoped URL', () => {
		const url = new URL('http://localhost/index.php');
		expect(removeURLScope(url)).toBe(url);
	});
});

describe('setURLScope', () => {
	it('should add the scope to a non-scoped URL', () => {
		const url = new URL('http://localhost/index.php');
		expect(setURLScope(url, 'new-scope').href).toBe(
			'http://localhost/scope:new-scope/index.php'
		);
	});

	it('should replace the scope in a scoped URL', () => {
		const url = new URL('http://localhost/scope:old-scope/index.php');
		expect(setURLScope(url, 'new-scope').href).toBe(
			'http://localhost/scope:new-scope/index.php'
		);
	});

	it('should remove the scope from a URL when the scope is null', () => {
		const url = new URL('http://localhost/scope:12345/index.php');
		expect(setURLScope(url, null).href).toBe('http://localhost/index.php');
	});
});

describe('appendPathnameToBaseUrlAndMaintainScope', () => {
	it('should preserve full base url when relative url is provided', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/'),
				'/wp-admin/index.php'
			)
		).toBe('http://localhost/scope:123/wp-admin/index.php');
	});
	it('should preserve full base url when relative reference is provided', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/'),
				'index.php'
			)
		).toBe('http://localhost/scope:123/index.php');
	});
	it('should preserve full base url when relative current directory reference is provided', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/'),
				'./test'
			)
		).toBe('http://localhost/scope:123/test');
	});

	it('should preserve query params', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/'),
				'index.php?test=1'
			)
		).toBe('http://localhost/scope:123/index.php?test=1');
	});

	it('should preserve relative url scope if it exists', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/'),
				'/scope:relative/index.php'
			)
		).toBe('http://localhost/scope:relative/index.php');
	});

	it('should preserve base url subfolder', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/scope:123/subfolder/'),
				'index.php'
			)
		).toBe('http://localhost/scope:123/subfolder/index.php');
	});

	it('should return a unscoped url if base url is unscoped', () => {
		expect(
			appendPathnameToBaseUrlAndMaintainScope(
				new URL('http://localhost/'),
				'index.php'
			)
		).toBe('http://localhost/index.php');
	});
});
