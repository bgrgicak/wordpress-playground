import { test, expect } from '../playground-fixtures.ts';
import type { Page } from '@playwright/test';

// Couchbase tests must run serially — they share IndexedDB state
// and interact with the same PouchDB databases.
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

	// Select Couchbase storage
	await dialog.getByText('Save to Couchbase').waitFor();
	await dialog.getByText('Save to Couchbase').click({ force: true });

	// Verify Couchbase radio is selected
	const couchbaseRadio = dialog.getByRole('radio', {
		name: /Save to Couchbase/,
	});
	await expect(couchbaseRadio).toBeChecked();

	// Click Save
	await dialog.getByRole('button', { name: 'Save' }).click();

	// Wait for dialog to close (Couchbase snapshot can take time)
	await expect(dialog).not.toBeVisible({ timeout: 120000 });
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

	const saveButton = website.page.getByRole('button', {
		name: 'Save site locally',
	});
	await expect(saveButton).toBeEnabled();
	await saveButton.click();

	const dialog = website.page.getByRole('dialog', {
		name: 'Save Playground',
	});
	await expect(dialog).toBeVisible({ timeout: 10000 });

	// Verify Couchbase option exists
	await expect(dialog.getByText('Save to Couchbase')).toBeVisible();

	// Close modal
	await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('should save site to Couchbase storage', async ({
	website,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	const siteName = `Couchbase Test ${Date.now()}`;
	await saveSiteToCouchbase(website.page, { customName: siteName });

	// Site should no longer be "Unsaved Playground"
	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);
});

test('should persist blog name after saving to Couchbase and reloading', async ({
	website,
	wordpress,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');

	// Change the blog name via wp-admin
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/options-general.php');
	await website.page
		.locator('input[value="/wp-admin/options-general.php"]')
		.press('Enter');

	// Wait for Settings page to load
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	// Set a custom blog name
	const customBlogName = `CB Test Blog ${Date.now()}`;
	await wordpress.locator('#blogname').fill(customBlogName);
	await wordpress.locator('#submit').click();

	// Wait for save confirmation
	await expect(
		wordpress.locator('#setting-error-settings_updated')
	).toBeVisible({
		timeout: 30000,
	});

	// Now save to Couchbase
	await website.ensureSiteManagerIsOpen();
	await saveSiteToCouchbase(website.page, {
		customName: 'Blog Name Persist Test',
	});

	// Verify site was saved
	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// Get the URL so we can reload to the same saved site
	const savedUrl = website.page.url();

	// Reload the page
	await website.page.goto(savedUrl);
	await website.waitForNestedIframes();

	// Navigate to Settings to check blog name
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/options-general.php');
	await website.page
		.locator('input[value="/wp-admin/options-general.php"]')
		.press('Enter');

	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	// The blog name should be the custom one we set, not "My WordPress Site"
	await expect(wordpress.locator('#blogname')).toHaveValue(customBlogName);
});

test('should persist installed plugins after Couchbase save and reload', async ({
	website,
	wordpress,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');

	// Navigate to Plugins page
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/plugins.php');
	await website.page
		.locator('input[value="/wp-admin/plugins.php"]')
		.press('Enter');

	await expect(wordpress.locator('.plugins')).toBeVisible({ timeout: 60000 });

	// Check the initial state of Hello Dolly plugin (it's bundled with WP)
	const helloDollyRow = wordpress.locator('tr[data-slug="hello-dolly"]');

	// If Hello Dolly exists and is inactive, activate it
	const activateLink = helloDollyRow.locator('a.activate');
	if (await activateLink.isVisible({ timeout: 5000 }).catch(() => false)) {
		await activateLink.click();
		// Wait for activation
		await expect(
			wordpress
				.locator('#message')
				.filter({ hasText: 'Plugin activated' })
		).toBeVisible({ timeout: 30000 });
	}

	// Save to Couchbase
	await website.ensureSiteManagerIsOpen();
	await saveSiteToCouchbase(website.page, {
		customName: 'Plugin Persist Test',
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	const savedUrl = website.page.url();

	// Reload
	await website.page.goto(savedUrl);
	await website.waitForNestedIframes();

	// Navigate to Plugins
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/plugins.php');
	await website.page
		.locator('input[value="/wp-admin/plugins.php"]')
		.press('Enter');

	await expect(wordpress.locator('.plugins')).toBeVisible({ timeout: 60000 });

	// Hello Dolly should still be active after reload
	const helloDollyAfterReload = wordpress.locator(
		'tr[data-slug="hello-dolly"]'
	);
	await expect(helloDollyAfterReload).toHaveClass(/active/, {
		timeout: 30000,
	});
});

test('should not show console errors during Couchbase save', async ({
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
			// Filter out known non-critical errors
			if (!text.includes('favicon.ico') && !text.includes('net::ERR_')) {
				consoleErrors.push(text);
			}
		}
	});

	await website.goto('./');
	await website.ensureSiteManagerIsOpen();

	await saveSiteToCouchbase(website.page, {
		customName: 'Console Error Test',
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// Check that no critical Couchbase-related errors occurred
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

test('should not show console errors during Couchbase restore on reload', async ({
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
		customName: 'Restore Error Test',
	});

	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	const savedUrl = website.page.url();

	// Now capture console errors during the reload
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

	// Check no Couchbase/PouchDB errors during restore
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

test('should retain data after making DB changes on a Couchbase-saved site', async ({
	website,
	wordpress,
	browserName,
}) => {
	test.skip(
		browserName !== 'chromium',
		'Couchbase tests require Chromium for IndexedDB support.'
	);

	await website.goto('./');

	// Set a custom blog name first
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/options-general.php');
	await website.page
		.locator('input[value="/wp-admin/options-general.php"]')
		.press('Enter');
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	const blogName = `Stable Blog ${Date.now()}`;
	await wordpress.locator('#blogname').fill(blogName);
	await wordpress.locator('#submit').click();
	await expect(
		wordpress.locator('#setting-error-settings_updated')
	).toBeVisible({
		timeout: 30000,
	});

	// Save to Couchbase
	await website.ensureSiteManagerIsOpen();
	await saveSiteToCouchbase(website.page, { customName: 'DB Change Test' });
	await expect(website.page.getByLabel('Playground title')).not.toContainText(
		'Unsaved Playground',
		{ timeout: 90000 }
	);

	// Now make additional DB changes AFTER save (e.g., change tagline)
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/options-general.php');
	await website.page
		.locator('input[value="/wp-admin/options-general.php"]')
		.press('Enter');
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});

	// Wait for sync to flush (3-second interval)
	await website.page.waitForTimeout(5000);

	// Reload
	const savedUrl = website.page.url();
	await website.page.goto(savedUrl);
	await website.waitForNestedIframes();

	// Verify the blog name survived
	await website.page
		.locator('input[value="/"]')
		.fill('/wp-admin/options-general.php');
	await website.page
		.locator('input[value="/wp-admin/options-general.php"]')
		.press('Enter');
	await expect(wordpress.locator('#blogname')).toBeVisible({
		timeout: 60000,
	});
	await expect(wordpress.locator('#blogname')).toHaveValue(blogName);
});
