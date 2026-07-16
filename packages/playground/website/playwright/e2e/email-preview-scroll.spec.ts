import { expect, test } from '../playground-fixtures.ts';

test('should use only the Email pane scrollbar for tall HTML messages', async ({
	website,
	wordpress,
}) => {
	await website.goto('./?storage=temp');
	await expect(wordpress.locator('body')).toContainText('Hello world!');

	await website.page.evaluate(async () => {
		const result = await (window as any).playground.run({
			code: `<?php
require_once '/wordpress/wp-load.php';
add_filter('wp_mail_content_type', function() { return 'text/html'; });
wp_mail(
	'recipient@example.com',
	'Tall HTML preview',
	'<div style="height: 900px">Tall message body</div>'
);
`,
		});
		if (result.exitCode !== 0) {
			throw new Error(result.errors || 'Failed to send test mail');
		}
	});

	await website.openDockPane('Email');

	const mailPanel = website.page.getByRole('region', { name: 'Email' });
	const previewPane = mailPanel.locator('[class*="mail-preview"]');
	const htmlPreview = mailPanel.getByTitle('Contents of Tall HTML preview');
	await expect(htmlPreview).toBeAttached();

	const initialHeight = await htmlPreview.evaluate(
		(iframe) => iframe.clientHeight
	);
	await htmlPreview
		.contentFrame()
		.getByText('Tall message body')
		.evaluate((body) => (body.style.height = '1200px'));
	await expect
		.poll(() => htmlPreview.evaluate((iframe) => iframe.clientHeight))
		.toBeGreaterThan(initialHeight);
	await expect
		.poll(() =>
			htmlPreview.evaluate((iframe) => {
				const previewDocument = iframe.contentDocument;
				return (
					!!previewDocument &&
					previewDocument.documentElement.scrollHeight <=
						iframe.clientHeight + 1
				);
			})
		)
		.toBe(true);
	await expect
		.poll(() =>
			previewPane.evaluate(
				(preview) => preview.scrollHeight > preview.clientHeight
			)
		)
		.toBe(true);
});
