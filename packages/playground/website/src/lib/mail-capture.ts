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
	receivedAt: number;
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
	const handleMailReceived = async (event: unknown) => {
		if (!isMailReceivedEvent(event)) {
			return;
		}

		const receivedAt = Date.now();
		const id = `${siteSlug}-${receivedAt}-${nextMessageId++}`;
		let mail: CapturedMail;
		try {
			mail = await parseMailMessage(event.message, { id, receivedAt });
		} catch (error) {
			mail = createFailedMail(id, receivedAt, error);
		}

		if (!signal.aborted) {
			onMail(mail);
		}
	};

	const removeListener = client.addEventListener(
		'email.received',
		handleMailReceived
	);
	signal.addEventListener(
		'abort',
		() => {
			void removeListener.then((remove) => remove());
		},
		{ once: true }
	);
}

export async function parseMailMessage(
	message: string,
	{ id, receivedAt }: Pick<CapturedMail, 'id' | 'receivedAt'>
): Promise<CapturedMail> {
	const parsed = await PostalMime.parse(message, {
		attachmentEncoding: 'base64',
	});
	const attachments = parsed.attachments.map(formatAttachment);

	return {
		id,
		receivedAt,
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

function isMailReceivedEvent(
	event: unknown
): event is { type: 'email.received'; message: string } {
	return (
		typeof event === 'object' &&
		event !== null &&
		(event as { type?: unknown }).type === 'email.received' &&
		typeof (event as { message?: unknown }).message === 'string'
	);
}

function createFailedMail(
	id: string,
	receivedAt: number,
	error: unknown
): CapturedMail {
	return {
		id,
		receivedAt,
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
