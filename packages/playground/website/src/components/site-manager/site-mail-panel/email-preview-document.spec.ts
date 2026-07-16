import { describe, expect, it } from 'vitest';
import { createEmailPreviewDocument } from './email-preview-document';

describe('createEmailPreviewDocument', () => {
	it('blocks scripts and opens links in a new browsing context by default', () => {
		const emailHtml =
			'<script>document.body.textContent = "unsafe";</script>' +
			'<a href="https://example.com">Example</a>';
		const document = createEmailPreviewDocument(emailHtml);

		expect(document).toContain("script-src 'none'");
		expect(document).toContain('<base target="_blank">');
		expect(document.indexOf('<base target="_blank">')).toBeLessThan(
			document.indexOf(emailHtml)
		);
		expect(document).toContain(
			'<script>document.body.textContent = "unsafe";</script>'
		);
	});

	it('leaves scrolling to the parent email preview', () => {
		const document = createEmailPreviewDocument('<p>Message</p>');

		expect(document).toContain('html { overflow: hidden !important; }');
	});
});
