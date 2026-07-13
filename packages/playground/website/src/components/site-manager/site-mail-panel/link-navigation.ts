import { getURLScope, removeURLScope } from '@php-wasm/scopes';

export type EmailLinkAction =
	| { type: 'playground'; path: string; url: string }
	| { type: 'external'; url: string };

export function getEmailLinkAction(
	href: string,
	playgroundScope: string
): EmailLinkAction | undefined {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return undefined;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}

	if (getURLScope(url) === playgroundScope) {
		const unscopedUrl = removeURLScope(url);
		return {
			type: 'playground',
			path: `${unscopedUrl.pathname}${unscopedUrl.search}${unscopedUrl.hash}`,
			url: url.href,
		};
	}

	return { type: 'external', url: url.href };
}
