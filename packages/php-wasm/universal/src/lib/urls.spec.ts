import { toAbsoluteUrl } from './urls';

describe('toAbsoluteUrl', () => {
	it('should preserve full base url when relative url is provided', () => {
		expect(
			toAbsoluteUrl(
				'/wp-admin/index.php',
				new URL('http://localhost/scope:123/')
			)
		).toBe('http://localhost/scope:123/wp-admin/index.php');
	});
	it('should preserve full base url when relative reference is provided', () => {
		expect(
			toAbsoluteUrl('index.php', new URL('http://localhost/scope:123/'))
		).toBe('http://localhost/scope:123/index.php');
	});
	it('should preserve full base url when relative current directory reference is provided', () => {
		expect(
			toAbsoluteUrl('./test', new URL('http://localhost/scope:123/'))
		).toBe('http://localhost/scope:123/test');
	});

	it('should preserve query params', () => {
		expect(
			toAbsoluteUrl(
				'index.php?test=1',
				new URL('http://localhost/scope:123/')
			)
		).toBe('http://localhost/scope:123/index.php?test=1');
	});

	it('should preserve base url subfolder', () => {
		expect(
			toAbsoluteUrl(
				'index.php',
				new URL('http://localhost/scope:123/subfolder/')
			)
		).toBe('http://localhost/scope:123/subfolder/index.php');
	});

	it('should return original URL when a absolute url is provided', () => {
		expect(
			toAbsoluteUrl(
				'http://127.0.0.1:123/index.php',
				new URL('http://localhost/scope:123/')
			)
		).toBe('http://127.0.0.1:123/index.php');
	});

	it('should return a unscoped url if base url is unscoped', () => {
		expect(toAbsoluteUrl('index.php', new URL('http://localhost/'))).toBe(
			'http://localhost/index.php'
		);
	});
});
