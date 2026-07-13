import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEmailPreviewDocument } from './email-preview-document';

describe('createEmailPreviewDocument', () => {
	it('allows only the exact link relay script through the content security policy', () => {
		const document = createEmailPreviewDocument(
			'<script>document.body.textContent = "unsafe";</script>',
			'test-channel'
		);
		const relayScript = document.match(
			/<script data-channel="test-channel">(.*?)<\/script>/
		)?.[1];
		expect(relayScript).toBeDefined();

		const relayScriptHash = createHash('sha256')
			.update(relayScript!)
			.digest('base64');
		expect(document).toContain(`script-src 'sha256-${relayScriptHash}'`);
		expect(document).toContain(
			'<script>document.body.textContent = "unsafe";</script>'
		);
	});
});
