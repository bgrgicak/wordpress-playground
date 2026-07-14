import { describe, expect, it } from 'vitest';
import { parseMailMessage } from './mail-capture';

describe('parseMailMessage', () => {
	it('parses raw RFC822 mail for the website UI', async () => {
		const mail = await parseMailMessage(
			[
				'From: Playground <sender@example.com>',
				'To: Recipient <recipient@example.com>',
				'Cc: copy@example.com',
				'Subject: Welcome to Playground',
				'Date: Fri, 10 Jul 2026 12:00:00 +0000',
				'Content-Type: text/plain; charset=utf-8',
				'',
				'Hello from Playground!',
			].join('\r\n'),
			{ id: 'mail-1' }
		);

		expect(mail).toMatchObject({
			id: 'mail-1',
			from: 'Playground <sender@example.com>',
			to: ['Recipient <recipient@example.com>'],
			cc: ['copy@example.com'],
			subject: 'Welcome to Playground',
		});
		expect(mail.text?.trim()).toBe('Hello from Playground!');
	});

	it('keeps HTML and attachment contents for previewing and download', async () => {
		const mail = await parseMailMessage(
			[
				'From: sender@example.com',
				'To: recipient@example.com',
				'MIME-Version: 1.0',
				'Content-Type: multipart/mixed; boundary="mail-boundary"',
				'',
				'--mail-boundary',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>Hello <strong>there</strong></p>',
				'--mail-boundary',
				'Content-Type: text/plain; name="hello.txt"',
				'Content-Disposition: attachment; filename="hello.txt"',
				'Content-Transfer-Encoding: base64',
				'',
				'aGVsbG8=',
				'--mail-boundary--',
			].join('\r\n'),
			{ id: 'mail-2' }
		);

		expect(mail.html).toContain('<strong>there</strong>');
		expect(mail.attachments).toEqual([
			{
				filename: 'hello.txt',
				mimeType: 'text/plain',
				size: 5,
				dataUrl: 'data:text/plain;base64,aGVsbG8=',
			},
		]);
	});

	it('embeds related attachments referenced by content ID', async () => {
		const mail = await parseMailMessage(
			[
				'From: sender@example.com',
				'To: recipient@example.com',
				'MIME-Version: 1.0',
				'Content-Type: multipart/related; boundary="related-boundary"',
				'',
				'--related-boundary',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>Logo: <img src="cid:logo@example.com"></p>',
				'--related-boundary',
				'Content-Type: image/png; name="logo.png"',
				'Content-Disposition: inline; filename="logo.png"',
				'Content-ID: <logo@example.com>',
				'Content-Transfer-Encoding: base64',
				'',
				'UE5H',
				'--related-boundary--',
			].join('\r\n'),
			{ id: 'mail-3' }
		);

		expect(mail.html).toContain('src="data:image/png;base64,UE5H"');
		expect(mail.attachments).toEqual([
			{
				filename: 'logo.png',
				mimeType: 'image/png',
				size: 3,
				dataUrl: 'data:image/png;base64,UE5H',
				contentId: 'logo@example.com',
			},
		]);
	});
});
