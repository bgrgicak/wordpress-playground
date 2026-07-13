import {
	Notice,
	SelectControl,
	__experimentalDivider as Divider,
	__experimentalHeading as Heading,
	__experimentalText as Text,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { useState } from 'react';
import type { CapturedMail } from '../../../lib/mail-capture';
import css from './style.module.css';

const EMAIL_PREVIEW_DOCUMENT_PREFIX = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">
<style>
	body { color: #1e1e1e; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; overflow-wrap: anywhere; }
	img { height: auto; max-width: 100%; }
	pre { white-space: pre-wrap; }
</style>`;

export function SiteMailPanel({ mail }: { mail: CapturedMail[] }) {
	const [selectedMailId, setSelectedMailId] = useState<string>();
	const selectedMail =
		mail.find(({ id }) => id === selectedMailId) || mail[0];

	return (
		<section aria-label="Mail">
			{selectedMail ? (
				<VStack spacing={4}>
					<SelectControl
						label={`Received messages (${mail.length})`}
						value={selectedMail.id}
						options={mail.map((message) => ({
							value: message.id,
							label: `${message.subject} — ${
								message.from || 'Unknown sender'
							} — ${formatReceivedTime(message.receivedAt)}`,
						}))}
						onChange={setSelectedMailId}
						__nextHasNoMarginBottom
					/>
					<MailPreview mail={selectedMail} />
				</VStack>
			) : (
				<VStack spacing={2}>
					<Heading level={2}>No mail yet</Heading>
					<Text>
						Messages sent by this Playground will appear here.
					</Text>
				</VStack>
			)}
		</section>
	);
}

function MailPreview({ mail }: { mail: CapturedMail }) {
	return (
		<VStack spacing={4}>
			<VStack spacing={2}>
				<Heading level={2}>{mail.subject}</Heading>
				<VStack spacing={1}>
					{mail.from && (
						<Text>
							<strong>From:</strong> {mail.from}
						</Text>
					)}
					{mail.to.length > 0 && (
						<Text>
							<strong>To:</strong> {mail.to.join(', ')}
						</Text>
					)}
					{mail.cc.length > 0 && (
						<Text>
							<strong>Cc:</strong> {mail.cc.join(', ')}
						</Text>
					)}
					<Text>
						<strong>Received:</strong> {formatDate(mail.receivedAt)}
					</Text>
					{mail.date && (
						<Text>
							<strong>Sent:</strong> {formatDate(mail.date)}
						</Text>
					)}
				</VStack>
			</VStack>
			<Divider />
			{mail.parseError ? (
				<Notice status="error" isDismissible={false}>
					The message could not be parsed: {mail.parseError}
				</Notice>
			) : mail.html ? (
				<iframe
					className={css.htmlPreview}
					title={`Contents of ${mail.subject}`}
					sandbox=""
					srcDoc={EMAIL_PREVIEW_DOCUMENT_PREFIX + mail.html}
				/>
			) : mail.text ? (
				<pre className={css.textBody}>{mail.text}</pre>
			) : (
				<Text>This message has no body.</Text>
			)}
			{mail.attachments.length > 0 && (
				<>
					<Divider />
					<VStack spacing={2}>
						<Heading level={3}>
							{mail.attachments.length === 1
								? '1 attachment'
								: `${mail.attachments.length} attachments`}
						</Heading>
						<VStack
							as="ul"
							spacing={1}
							className={css.attachmentList}
						>
							{mail.attachments.map((attachment, index) => (
								<Text
									as="li"
									key={`${attachment.filename}-${index}`}
								>
									<strong>{attachment.filename}</strong> —{' '}
									{attachment.mimeType},{' '}
									{formatFileSize(attachment.size)}
								</Text>
							))}
						</VStack>
					</VStack>
				</>
			)}
		</VStack>
	);
}

function formatReceivedTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
	}).format(timestamp);
}

function formatDate(value: string | number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
