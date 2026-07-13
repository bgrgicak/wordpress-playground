import { describe, expect, it } from 'vitest';
import { getEmailLinkAction } from './link-navigation';

describe('getEmailLinkAction', () => {
	it('routes links for the current Playground to an unscoped path', () => {
		expect(
			getEmailLinkAction(
				'https://playground.test/scope:my-site/wp-login.php?action=rp#form',
				'my-site'
			)
		).toEqual({
			type: 'playground',
			path: '/wp-login.php?action=rp#form',
			url: 'https://playground.test/scope:my-site/wp-login.php?action=rp#form',
		});
	});

	it('opens links for another Playground in a new tab', () => {
		expect(
			getEmailLinkAction(
				'https://playground.test/scope:another-site/',
				'my-site'
			)
		).toEqual({
			type: 'external',
			url: 'https://playground.test/scope:another-site/',
		});
	});

	it('opens unscoped and third-party links in a new tab', () => {
		expect(
			getEmailLinkAction('https://playground.test/wp-admin/', 'my-site')
		).toEqual({
			type: 'external',
			url: 'https://playground.test/wp-admin/',
		});
		expect(
			getEmailLinkAction('https://wordpress.org/plugins/', 'my-site')
		).toEqual({
			type: 'external',
			url: 'https://wordpress.org/plugins/',
		});
	});

	it('ignores malformed and non-web links', () => {
		expect(getEmailLinkAction('not a URL', 'my-site')).toBeUndefined();
		const scriptUrl = ['java', 'script:alert(document.domain)'].join('');
		expect(getEmailLinkAction(scriptUrl, 'my-site')).toBeUndefined();
		expect(
			getEmailLinkAction('data:text/html,unsafe', 'my-site')
		).toBeUndefined();
	});
});
