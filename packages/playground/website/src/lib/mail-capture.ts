import PostalMime from 'postal-mime';
import type { Address, Attachment } from 'postal-mime';
import type { PlaygroundClient } from '@wp-playground/remote';

export interface CapturedMailAttachment {
	filename: string;
	mimeType: string;
	size: number;
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

	void client.addEventListener('mail.received', handleMailReceived);
	signal.addEventListener(
		'abort',
		() => {
			void client.removeEventListener(
				'mail.received',
				handleMailReceived
			);
		},
		{ once: true }
	);
}

export async function parseMailMessage(
	message: string,
	{ id, receivedAt }: Pick<CapturedMail, 'id' | 'receivedAt'>
): Promise<CapturedMail> {
	const parsed = await PostalMime.parse(message);

	return {
		id,
		receivedAt,
		from: parsed.from ? formatAddress(parsed.from) : undefined,
		to: formatAddressList(parsed.to),
		cc: formatAddressList(parsed.cc),
		subject: parsed.subject || '(No subject)',
		date: parsed.date,
		html: parsed.html,
		text: parsed.text,
		attachments: parsed.attachments.map(formatAttachment),
	};
}

function isMailReceivedEvent(
	event: unknown
): event is { type: 'mail.received'; message: string } {
	return (
		typeof event === 'object' &&
		event !== null &&
		(event as { type?: unknown }).type === 'mail.received' &&
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
	return {
		filename: attachment.filename || 'Unnamed attachment',
		mimeType: attachment.mimeType,
		size: getAttachmentSize(attachment.content),
	};
}

function getAttachmentSize(content: Attachment['content']): number {
	return typeof content === 'string'
		? new TextEncoder().encode(content).byteLength
		: content.byteLength;
}
