export function createEmailPreviewDocument(html: string): string {
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
