import { test, expect } from '../playground-fixtures.ts';
import type { FrameLocator, Page } from '@playwright/test';

// Couchbase tests must run serially — they share IndexedDB state.
test.describe.configure({ mode: 'serial' });

/**
 * Save the current site to Couchbase storage via the save modal.
 */
async function saveSiteToCouchbase(
	page: Page,
	options?: { customName?: string }
) {
	const { customName } = options || {};

	const saveButton = page.getByRole('button', { name: 'Save site locally' });
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = page.getByRole('dialog', { name: 'Save Playground' });
	await expect(dialog).toBeVisible({ timeout: 10000 });

	if (customName) {
		const nameInput = dialog.getByLabel('Playground name');
		await nameInput.fill('');
		await nameInput.type(customName);
	}

	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });

	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(dialog).not.toBeVisible({ timeout: 120000 });
}

/**
 * Navigate to a WordPress admin page via the iframe.
 */
async function navigateInWordPress(
	wordpress: FrameLocator,
	linkSelector: string,
	waitForSelector: string
) {
	await wordpress.locator(linkSelector).click();
	await expect(wordpress.locator(waitForSelector)).toBeVisible({
		timeout: 60000,
	});
}

test('should show Couchbase as a storage option in save modal', async ({
	website,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await website.page
		.getByRole('button', { name: 'Save site locally' })
		.click();

	const dialog = website.page.getByRole('dialog', {
		name: 'Save Playground',
	});
	await expect(dialog).toBeVisible({ timeout: 10000 });
	await expect(dialog.getByText('Save to Couchbase')).toBeVisible();

	await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('should save site to Couchbase without console errors', async ({
	website,
	browserName,
	page,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	const consoleErrors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			const text = msg.text();
			if (!text.includes('favicon.ico') && !text.includes('net::ERR_')) {
				consoleErrors.push(text);
			}
		}
	});

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `CB Save Test ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	const couchbaseErrors = consoleErrors.filter(
		(e) =>
			e.includes('CouchbaseSync') ||
			e.includes('PouchDB') ||
			e.includes('pouchdb') ||
			e.includes('require is not defined') ||
			e.includes('playground_sync_replay_sql_journal')
	);
	expect(couchbaseErrors).toEqual([]);
});

test('should restore without errors on reload', async ({
	website,
	browserName,
	page,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `CB Restore Test ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	const savedUrl = website.page.url();

	const consoleErrors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			const text = msg.text();
			if (!text.includes('favicon.ico') && !text.includes('net::ERR_')) {
				consoleErrors.push(text);
			}
		}
	});

	await page.goto(savedUrl);
	await website.waitForNestedIframes();

	const couchbaseErrors = consoleErrors.filter(
		(e) =>
			e.includes('CouchbaseSync') ||
			e.includes('PouchDB') ||
			e.includes('pouchdb') ||
			e.includes('require is not defined') ||
			e.includes('playground_sync_replay_sql_journal') ||
			e.includes('PHP.run() failed')
	);
	expect(couchbaseErrors).toEqual([]);
});

test('should persist blog name changed AFTER Couchbase save on reload', async ({
	website,
	wordpress,
	browserName,
	page,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	// 1. Load site, save to Couchbase
	await website.goto('./?url=/wp-admin/');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: `Post-save Blog ${Date.now()}`,
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);
	await website.ensureSiteManagerIsClosed();

	// 2. After site reboot, navigate to Settings via WordPress admin
	await website.waitForNestedIframes();
	// Navigate: Settings → General
	await wordpress
		.locator('#menu-settings a.menu-top')
		.evaluate((el) => (el as HTMLElement).click());
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	// 3. Change blog name through the actual WordPress UI
	const customBlogName = `CB Blog ${Date.now()}`;
	await wordpress.locator('#blogname').fill(customBlogName);
	await wordpress.locator('#submit').click();

	// Wait for save confirmation
	await expect(
		wordpress.locator('#setting-error-settings_updated')
	).toBeVisible({ timeout: 30000 });

	// 4. Wait for periodic snapshot to run (5s interval + margin)
	await page.waitForTimeout(8000);

	// 5. Reload
	const savedUrl = website.page.url();
	await page.goto(savedUrl);
	await website.waitForNestedIframes();

	// 6. Navigate to Settings and verify blog name
	await wordpress
		.locator('#menu-settings a.menu-top')
		.evaluate((el) => (el as HTMLElement).click());
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	await expect(wordpress.locator('#blogname')).toHaveValue(customBlogName);
});
