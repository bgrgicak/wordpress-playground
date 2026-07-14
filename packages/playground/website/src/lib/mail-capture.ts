import PostalMime from 'postal-mime';
import type { Address, Attachment } from 'postal-mime';
import type { PlaygroundClient } from '@wp-playground/remote';

export interface CapturedMailAttachment {
	filename: string;
	mimeType: string;
	size: number;
	dataUrl: string;
	contentId?: string;
}

export interface CapturedMail {
	id: string;
	from?: string;
	to: string[];
	cc: string[];
	subject: string;
	date?: string;
	html?: string;
	text?: string;
	attachments: CapturedMailAttachment[];
	parseError?: string;
}

export function subscribeToMail({
	client,
	siteSlug,
	signal,
	onMail,
}: {
	client: PlaygroundClient;
	siteSlug: string;
	signal: AbortSignal;
	onMail: (mail: CapturedMail) => void;
}) {
	if (signal.aborted) {
		return;
	}

	let nextMessageId = 0;
	const handleMailSent = async (event: unknown) => {
		if (signal.aborted || !isMailSentEvent(event)) {
			return;
		}

		const id = `${siteSlug}-${nextMessageId++}`;
		let mail: CapturedMail;
		try {
			mail = await parseMailMessage(event.message, { id });
		} catch (error) {
			mail = createFailedMail(id, error);
		}

		if (!signal.aborted) {
			onMail(mail);
		}
	};

	void client.addEventListener('email.sent', handleMailSent);
}

export async function parseMailMessage(
	message: string,
	{ id }: Pick<CapturedMail, 'id'>
): Promise<CapturedMail> {
	const parsed = await PostalMime.parse(message, {
		attachmentEncoding: 'base64',
	});
	const attachments = parsed.attachments.map(formatAttachment);

	return {
		id,
		from: parsed.from ? formatAddress(parsed.from) : undefined,
		to: formatAddressList(parsed.to),
		cc: formatAddressList(parsed.cc),
		subject: parsed.subject || '(No subject)',
		date: parsed.date,
		html: parsed.html
			? embedRelatedAttachments(parsed.html, attachments)
			: undefined,
		text: parsed.text,
		attachments,
	};
}

function isMailSentEvent(
	event: unknown
): event is { type: 'email.sent'; message: string } {
	return (
		typeof event === 'object' &&
		event !== null &&
		(event as { type?: unknown }).type === 'email.sent' &&
		typeof (event as { message?: unknown }).message === 'string'
	);
}

function createFailedMail(id: string, error: unknown): CapturedMail {
	return {
		id,
		to: [],
		cc: [],
		subject: 'Unable to parse message',
		attachments: [],
		parseError: error instanceof Error ? error.message : String(error),
	};
}

function formatAddressList(addresses: Address[] | undefined): string[] {
	return addresses?.map(formatAddress) || [];
}

function formatAddress(address: Address): string {
	if ('group' in address && address.group) {
		const members = address.group.map(formatAddress).join(', ');
		return `${address.name}: ${members}`;
	}
	if (address.name && address.address) {
		return `${address.name} <${address.address}>`;
	}
	return address.address || address.name;
}

function formatAttachment(attachment: Attachment): CapturedMailAttachment {
	if (
		attachment.encoding !== 'base64' ||
		typeof attachment.content !== 'string'
	) {
		throw new Error('Expected attachment contents to be base64 encoded');
	}

	const contentId = attachment.contentId?.trim().replace(/^<|>$/g, '');

	return {
		filename: attachment.filename || 'Unnamed attachment',
		mimeType: attachment.mimeType,
		size: getBase64Size(attachment.content),
		dataUrl: `data:${attachment.mimeType};base64,${attachment.content}`,
		...(contentId ? { contentId } : {}),
	};
}

function embedRelatedAttachments(
	html: string,
	attachments: CapturedMailAttachment[]
): string {
	for (const attachment of attachments) {
		if (!attachment.contentId) {
			continue;
		}

		const contentIds = [
			attachment.contentId,
			encodeURIComponent(attachment.contentId),
		];
		for (const contentId of contentIds) {
			html = html.replace(
				new RegExp(`cid:${escapeRegExp(contentId)}`, 'gi'),
				() => attachment.dataUrl
			);
		}
	}

	return html;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBase64Size(content: string): number {
	const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
	return (content.length * 3) / 4 - padding;
}
