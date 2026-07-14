export const EMAIL_LINK_CLICK_MESSAGE_TYPE =
	'playground-email-link-click' as const;

const EMAIL_LINK_RELAY_SCRIPT =
	"const channel=document.currentScript.dataset.channel;document.addEventListener('click',(event)=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(!link)return;event.preventDefault();parent.postMessage({type:'playground-email-link-click',channel,href:link.href},'*')});";
const EMAIL_LINK_RELAY_SCRIPT_HASH =
	'aGgXO4fk1SHS/N+UZ/3TwBaroGIdutVaPfWB1Fc7JbU=';

export function createEmailPreviewDocument(
	html: string,
	messageChannel: string
): string {
	return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: blob:; media-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data: blob:; script-src 'sha256-${EMAIL_LINK_RELAY_SCRIPT_HASH}'; form-action 'none'; base-uri 'none'">
<style>
	html { overflow: hidden !important; }
	body { color: #1e1e1e; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; overflow-wrap: anywhere; }
	img { height: auto; max-width: 100%; }
	pre { white-space: pre-wrap; }
</style>
<script data-channel="${messageChannel}">${EMAIL_LINK_RELAY_SCRIPT}</script>
${html}`;
}
