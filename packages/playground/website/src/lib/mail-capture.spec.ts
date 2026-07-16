import { describe, expect, it } from 'vitest';
import type { PlaygroundClient } from '@wp-playground/remote';
import { parseMailMessage, subscribeToMail } from './mail-capture';

describe('subscribeToMail', () => {
	it('parses the streamed stdin from each sendmail spawn', async () => {
		let listener: ((event: unknown) => void) | undefined;
		const client = {
			addEventListener: vi.fn(
				async (_eventType: string, eventListener: typeof listener) => {
					listener = eventListener;
					return vi.fn();
				}
			),
		} as unknown as PlaygroundClient;
		const abortController = new AbortController();
		const onMail = vi.fn();
		subscribeToMail({
			client,
			siteSlug: 'test-site',
			signal: abortController.signal,
			onMail,
		});

		await vi.waitFor(() => expect(listener).toBeDefined());
		const message = [
			'From: sender@example.com',
			'To: recipient@example.com',
			'Subject: Streamed message',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Price: 10 €',
		].join('\r\n');
		const bytes = new TextEncoder().encode(message);
		const euroOffset = bytes.indexOf(0xe2);
		const stdin = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, euroOffset + 1));
				controller.enqueue(bytes.slice(euroOffset + 1));
				controller.close();
			},
		});

		listener!({ type: 'sendmail.spawned', stdin });

		await vi.waitFor(() => expect(onMail).toHaveBeenCalledOnce());
		expect(onMail.mock.calls[0][0]).toMatchObject({
			id: 'test-site-0',
			subject: 'Streamed message',
		});
		expect(onMail.mock.calls[0][0].text.trim()).toBe('Price: 10 €');
		expect(client.addEventListener).toHaveBeenCalledWith(
			'sendmail.spawned',
			listener
		);
	});

	it('removes the sendmail listener when the site is aborted', async () => {
		const removeListener = vi.fn();
		const client = {
			addEventListener: vi.fn(async () => removeListener),
		} as unknown as PlaygroundClient;
		const abortController = new AbortController();
		subscribeToMail({
			client,
			siteSlug: 'test-site',
			signal: abortController.signal,
			onMail: vi.fn(),
		});
		await vi.waitFor(() =>
			expect(client.addEventListener).toHaveBeenCalledOnce()
		);

		abortController.abort();

		await vi.waitFor(() => expect(removeListener).toHaveBeenCalledOnce());
	});
});

describe('parseMailMessage', () => {
	it('parses a complete MIME message for preview and download', async () => {
		const mail = await parseMailMessage(
			[
				'From: Playground <sender@example.com>',
				'To: Recipient <recipient@example.com>',
				'Cc: copy@example.com',
				'Subject: Welcome to Playground',
				'Date: Fri, 10 Jul 2026 12:00:00 +0000',
				'MIME-Version: 1.0',
				'Content-Type: multipart/mixed; boundary="mail-boundary"',
				'',
				'--mail-boundary',
				'Content-Type: multipart/alternative; boundary="body-boundary"',
				'',
				'--body-boundary',
				'Content-Type: text/plain; charset=utf-8',
				'',
				'Hello from Playground!',
				'--body-boundary',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>Hello <strong>there</strong></p>',
				'<img src="cid:logo@example.com">',
				'--body-boundary--',
				'--mail-boundary',
				'Content-Type: image/png; name="logo.png"',
				'Content-Disposition: inline; filename="logo.png"',
				'Content-ID: <logo@example.com>',
				'Content-Transfer-Encoding: base64',
				'',
				'UE5H',
				'--mail-boundary',
				'Content-Type: text/plain; name="hello.txt"',
				'Content-Disposition: attachment; filename="hello.txt"',
				'Content-Transfer-Encoding: base64',
				'',
				'aGVsbG8=',
				'--mail-boundary--',
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
		expect(mail.html).toContain('<strong>there</strong>');
		expect(mail.html).toContain('src="data:image/png;base64,UE5H"');
		expect(mail.attachments).toEqual([
			{
				filename: 'logo.png',
				mimeType: 'image/png',
				size: 3,
				dataUrl: 'data:image/png;base64,UE5H',
				contentId: 'logo@example.com',
			},
			{
				filename: 'hello.txt',
				mimeType: 'text/plain',
				size: 5,
				dataUrl: 'data:text/plain;base64,aGVsbG8=',
			},
		]);
	});
});
