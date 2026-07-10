import {
	Button,
	Card,
	CardBody,
	CardHeader,
	Notice,
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
		mail.find((message) => message.id === selectedMailId) || mail[0];

	if (!selectedMail) {
		return (
			<section className={css.emptyState} aria-label="Mail">
				<Card elevation={0} size="small">
					<CardBody>
						<h2 className={css.emptyStateTitle}>No mail yet</h2>
						<p className={css.emptyStateDescription}>
							Messages sent by this Playground will appear here.
						</p>
					</CardBody>
				</Card>
			</section>
		);
	}

	return (
		<section className={css.mailPanel} aria-label="Mail">
			<section className={css.mailList} aria-label="Received messages">
				<header className={css.mailListHeader}>
					<h2>Received</h2>
					<span>{mail.length}</span>
				</header>
				<div role="list">
					{mail.map((message) => {
						const isSelected = message.id === selectedMail.id;
						return (
							<div role="listitem" key={message.id}>
								<Button
									className={css.mailListItem}
									isPressed={isSelected}
									onClick={() =>
										setSelectedMailId(message.id)
									}
								>
									<span className={css.mailListItemContent}>
										<span
											className={css.mailListItemSubject}
										>
											{message.subject}
										</span>
										<span className={css.mailListItemMeta}>
											<span>
												{message.from ||
													'Unknown sender'}
											</span>
											<time
												dateTime={new Date(
													message.receivedAt
												).toISOString()}
											>
												{formatReceivedTime(
													message.receivedAt
												)}
											</time>
										</span>
									</span>
								</Button>
							</div>
						);
					})}
				</div>
			</section>
			<MailPreview mail={selectedMail} />
		</section>
	);
}

function MailPreview({ mail }: { mail: CapturedMail }) {
	return (
		<article className={css.mailPreview} aria-label="Selected message">
			<Card className={css.mailCard} elevation={0} size="small">
				<CardHeader className={css.mailHeader}>
					<h2>{mail.subject}</h2>
					<dl>
						{mail.from && (
							<>
								<dt>From</dt>
								<dd>{mail.from}</dd>
							</>
						)}
						{mail.to.length > 0 && (
							<>
								<dt>To</dt>
								<dd>{mail.to.join(', ')}</dd>
							</>
						)}
						{mail.cc.length > 0 && (
							<>
								<dt>Cc</dt>
								<dd>{mail.cc.join(', ')}</dd>
							</>
						)}
						<dt>Received</dt>
						<dd>{formatDate(mail.receivedAt)}</dd>
						{mail.date && (
							<>
								<dt>Sent</dt>
								<dd>{formatDate(mail.date)}</dd>
							</>
						)}
					</dl>
				</CardHeader>
				<CardBody className={css.mailBody}>
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
						<pre>{mail.text}</pre>
					) : (
						<p>This message has no body.</p>
					)}
				</CardBody>
				{mail.attachments.length > 0 && (
					<CardBody className={css.attachments} isShady>
						<h3>
							{mail.attachments.length === 1
								? '1 attachment'
								: `${mail.attachments.length} attachments`}
						</h3>
						<ul>
							{mail.attachments.map((attachment, index) => (
								<li key={`${attachment.filename}-${index}`}>
									<span>{attachment.filename}</span>
									<span>
										{attachment.mimeType} ·{' '}
										{formatFileSize(attachment.size)}
									</span>
								</li>
							))}
						</ul>
					</CardBody>
				)}
			</Card>
		</article>
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
