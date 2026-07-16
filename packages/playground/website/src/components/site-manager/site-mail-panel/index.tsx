import {
	Button,
	Card,
	CardBody,
	CardMedia,
	Icon,
	Notice,
	__experimentalDivider as Divider,
	__experimentalGrid as Grid,
	__experimentalHStack as HStack,
	__experimentalHeading as Heading,
	__experimentalItem as Item,
	__experimentalItemGroup as ItemGroup,
	__experimentalText as Text,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { download, file } from '@wordpress/icons';
import { useEffect, useRef, useState } from 'react';
import type {
	CapturedMail,
	CapturedMailAttachment,
} from '../../../lib/mail-capture';
import { createEmailPreviewDocument } from './email-preview-document';
import css from './style.module.css';

export function SiteMailPanel({ mail }: { mail: CapturedMail[] }) {
	const [selectedMailId, setSelectedMailId] = useState<string>();
	const selectedMail =
		mail.find(({ id }) => id === selectedMailId) || mail[0];

	if (!selectedMail) {
		return (
			<section className={css.emptyState} aria-label="Email">
				<Notice
					className={css.siteNotice}
					status="info"
					isDismissible={false}
				>
					<VStack spacing={2}>
						<Heading level={2}>No emails yet</Heading>
						<Text>
							Emails sent by this Playground will appear here.
						</Text>
					</VStack>
				</Notice>
			</section>
		);
	}

	return (
		<section className={css.mailPanel} aria-label="Email">
			<aside className={css.mailList} aria-label="Sent emails">
				<HStack className={css.mailListHeader}>
					<Text as="h2" weight={600}>
						Sent
					</Text>
					<Text variant="muted">{mail.length}</Text>
				</HStack>
				<ItemGroup isSeparated isRounded={false} size="large">
					{mail.map((message) => {
						const isSelected = message.id === selectedMail.id;

						return (
							<Item
								key={message.id}
								onClick={() => setSelectedMailId(message.id)}
								aria-pressed={isSelected}
								className={css.mailListItem}
							>
								<VStack spacing={1}>
									<Text weight={600} truncate>
										{message.subject}
									</Text>
									<HStack spacing={2}>
										<Text variant="muted" truncate>
											{message.from || 'Unknown sender'}
										</Text>
										{message.date && (
											<Text
												as="time"
												dateTime={message.date}
												variant="muted"
											>
												{formatSentTime(message.date)}
											</Text>
										)}
									</HStack>
								</VStack>
							</Item>
						);
					})}
				</ItemGroup>
			</aside>
			<MailPreview mail={selectedMail} />
		</section>
	);
}

function MailPreview({ mail }: { mail: CapturedMail }) {
	const htmlPreviewRef = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		const iframe = htmlPreviewRef.current;
		if (!iframe) {
			return;
		}
		const htmlPreview = iframe;

		let contentResizeObserver: ResizeObserver | undefined;
		let animationFrame: number | undefined;

		function observeIframeContents() {
			contentResizeObserver?.disconnect();
			const documentElement =
				htmlPreview.contentDocument?.documentElement;
			if (documentElement) {
				const observer = new ResizeObserver(resizeIframe);
				observer.observe(documentElement);
				contentResizeObserver = observer;
			}
			resizeIframe();
		}

		function resizeIframe() {
			if (animationFrame !== undefined) {
				return;
			}

			animationFrame = window.requestAnimationFrame(() => {
				animationFrame = undefined;
				const documentElement =
					htmlPreview.contentDocument?.documentElement;
				if (!documentElement) {
					return;
				}

				const contentHeight = Math.ceil(
					Math.max(
						documentElement.scrollHeight,
						documentElement.offsetHeight,
						documentElement.getBoundingClientRect().height
					)
				);
				htmlPreview.style.height = `${Math.max(1, contentHeight)}px`;
			});
		}

		// The sidebar can resize without the window changing size.
		const parentResizeObserver = new ResizeObserver(resizeIframe);
		if (htmlPreview.parentElement) {
			parentResizeObserver.observe(htmlPreview.parentElement);
		}

		htmlPreview.addEventListener('load', observeIframeContents);
		observeIframeContents();

		return () => {
			htmlPreview.removeEventListener('load', observeIframeContents);
			contentResizeObserver?.disconnect();
			parentResizeObserver.disconnect();
			if (animationFrame !== undefined) {
				window.cancelAnimationFrame(animationFrame);
			}
		};
	}, [mail.id]);

	return (
		<VStack className={css.mailPreview} spacing={4} justify="flex-start">
			<VStack spacing={2}>
				<Heading level={2}>{mail.subject}</Heading>
				<div className={css.mailMetadata}>
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
					</VStack>
					<VStack spacing={1}>
						{mail.date && (
							<Text>
								<strong>Sent:</strong> {formatDate(mail.date)}
							</Text>
						)}
						{mail.attachments.length > 0 && (
							<Text>
								<strong>Attachments:</strong>{' '}
								{mail.attachments.length}
							</Text>
						)}
					</VStack>
				</div>
			</VStack>
			<Divider />
			{mail.parseError ? (
				<Notice status="error" isDismissible={false}>
					The message could not be parsed: {mail.parseError}
				</Notice>
			) : mail.html ? (
				/* Same-origin keeps Playground resources under service-worker control.
				 * Popups escape the sandbox so linked sites work normally. */
				<iframe
					ref={htmlPreviewRef}
					className={
						mail.attachments.length > 0
							? `${css.htmlPreview} ${css.htmlPreviewWithAttachments}`
							: css.htmlPreview
					}
					title={`Contents of ${mail.subject}`}
					sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
					srcDoc={createEmailPreviewDocument(mail.html)}
				/>
			) : mail.text ? (
				<pre className={css.textBody}>{mail.text}</pre>
			) : (
				<Text>This message has no body.</Text>
			)}
			{mail.attachments.length > 0 && (
				<>
					<Divider />
					<VStack className={css.attachments} spacing={2}>
						<Heading level={3}>
							{mail.attachments.length === 1
								? '1 attachment'
								: `${mail.attachments.length} attachments`}
						</Heading>
						<Grid
							as="ul"
							alignment="stretch"
							gap={3}
							templateColumns="repeat(auto-fit, minmax(min(100%, 180px), 1fr))"
							className={css.attachmentList}
							aria-label="Attachments"
						>
							{mail.attachments.map((attachment, index) => (
								<li
									key={`${attachment.filename}-${index}`}
									className={css.attachmentItem}
								>
									<Card
										className={css.attachmentCard}
										elevation={0}
										size="small"
									>
										<CardMedia
											className={css.attachmentMedia}
										>
											<div
												className={
													css.attachmentPreview
												}
											>
												<AttachmentPreview
													attachment={attachment}
												/>
											</div>
											<VStack
												className={
													css.attachmentActions
												}
												spacing={2}
												justify="center"
											>
												<Text
													size={12}
													lineHeight="16px"
													variant="muted"
												>
													Size:{' '}
													{formatFileSize(
														attachment.size
													)}
												</Text>
												<Button
													className={
														css.attachmentDownload
													}
													variant="link"
													href={attachment.dataUrl}
													download={
														attachment.filename
													}
													label={`Download ${attachment.filename}`}
												>
													<Icon
														icon={download}
														size={16}
													/>
													<span>Download</span>
												</Button>
											</VStack>
										</CardMedia>
										<CardBody
											className={css.attachmentDetails}
											size="xSmall"
										>
											<Text
												className={
													css.attachmentFilename
												}
												weight={600}
												truncate
												numberOfLines={1}
												title={attachment.filename}
											>
												{attachment.filename}
											</Text>
										</CardBody>
									</Card>
								</li>
							))}
						</Grid>
					</VStack>
				</>
			)}
		</VStack>
	);
}

function AttachmentPreview({
	attachment,
}: {
	attachment: CapturedMailAttachment;
}) {
	if (attachment.mimeType.startsWith('image/')) {
		return (
			<img
				className={css.attachmentImage}
				src={attachment.dataUrl}
				alt={attachment.filename}
				loading="lazy"
			/>
		);
	}

	if (attachment.mimeType.startsWith('video/')) {
		return (
			<video className={css.attachmentVideo} controls preload="metadata">
				<source src={attachment.dataUrl} type={attachment.mimeType} />
			</video>
		);
	}

	if (attachment.mimeType.startsWith('audio/')) {
		return (
			<audio className={css.attachmentAudio} controls preload="metadata">
				<source src={attachment.dataUrl} type={attachment.mimeType} />
			</audio>
		);
	}

	return (
		<div className={css.attachmentPlaceholder} aria-hidden="true">
			<Icon icon={file} size={32} />
		</div>
	);
}

function formatSentTime(date: string): string {
	const parsedDate = new Date(date);
	if (Number.isNaN(parsedDate.getTime())) {
		return date;
	}
	return new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
	}).format(parsedDate);
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
