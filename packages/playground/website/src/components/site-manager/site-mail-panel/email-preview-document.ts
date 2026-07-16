export function createEmailPreviewDocument(html: string): string {
	/*
	 * Email bodies are untrusted fragments and may not include document metadata.
	 * UTF-8 and standards mode keep parsing consistent across messages. CSP blocks
	 * active content while retaining the assets and inline styles emails commonly
	 * use. The base target opens links outside the preview instead of replacing
	 * its contents.
	 */
	return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: blob:; media-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data: blob:; script-src 'none'; form-action 'none'; base-uri 'none'">
<base target="_blank">
<style>
	html { overflow: hidden !important; }
	body { color: #1e1e1e; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; overflow-wrap: anywhere; }
	img { height: auto; max-width: 100%; }
	pre { white-space: pre-wrap; }
</style>
${html}`;
}
