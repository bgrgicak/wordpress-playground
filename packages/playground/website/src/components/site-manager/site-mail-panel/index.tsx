import {
	Button,
	Card,
	CardBody,
	CardFooter,
	CardMedia,
	Icon,
	Notice,
	__experimentalConfirmDialog as ConfirmDialog,
	__experimentalDivider as Divider,
	__experimentalHStack as HStack,
	__experimentalHeading as Heading,
	__experimentalItem as Item,
	__experimentalItemGroup as ItemGroup,
	__experimentalText as Text,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { download, file } from '@wordpress/icons';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PlaygroundClient } from '@wp-playground/remote';
import type {
	CapturedMail,
	CapturedMailAttachment,
} from '../../../lib/mail-capture';
import {
	createEmailPreviewDocument,
	EMAIL_LINK_CLICK_MESSAGE_TYPE,
} from './email-preview-document';
import { getEmailLinkAction, type EmailLinkAction } from './link-navigation';
import css from './style.module.css';

type PlaygroundEmailLinkAction = Extract<
	EmailLinkAction,
	{ type: 'playground' }
>;

export function SiteMailPanel({
	mail,
	playground,
	playgroundScope,
}: {
	mail: CapturedMail[];
	playground: PlaygroundClient | undefined;
	playgroundScope: string;
}) {
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
				<Text as="p" className={css.mailListEnd} variant="muted">
					No more emails
				</Text>
			</aside>
			<MailPreview
				mail={selectedMail}
				playground={playground}
				playgroundScope={playgroundScope}
			/>
		</section>
	);
}

function MailPreview({
	mail,
	playground,
	playgroundScope,
}: {
	mail: CapturedMail;
	playground: PlaygroundClient | undefined;
	playgroundScope: string;
}) {
	const htmlPreviewRef = useRef<HTMLIFrameElement>(null);
	const [linkMessageChannel] = useState(() => crypto.randomUUID());
	const [pendingPlaygroundLink, setPendingPlaygroundLink] =
		useState<PlaygroundEmailLinkAction>();

	function navigateToPendingLink() {
		if (!pendingPlaygroundLink) {
			return;
		}

		setPendingPlaygroundLink(undefined);
		void playground?.goTo(pendingPlaygroundLink.path);
	}

	function cancelPendingLink() {
		setPendingPlaygroundLink(undefined);
	}

	function openPendingLinkInNewTab() {
		if (!pendingPlaygroundLink) {
			return;
		}

		setPendingPlaygroundLink(undefined);
		window.open(pendingPlaygroundLink.url, '_blank', 'noopener,noreferrer');
	}

	useEffect(() => {
		const iframe = htmlPreviewRef.current;
		if (!iframe) {
			return;
		}

		const handleLinkClick = (event: MessageEvent<unknown>) => {
			if (
				event.source !== iframe.contentWindow ||
				!isEmailLinkClickMessage(event.data, linkMessageChannel)
			) {
				return;
			}

			const action = getEmailLinkAction(event.data.href, playgroundScope);
			if (action?.type === 'playground') {
				setPendingPlaygroundLink(action);
			} else if (action?.type === 'external') {
				window.open(action.url, '_blank', 'noopener,noreferrer');
			}
		};

		window.addEventListener('message', handleLinkClick);
		return () => window.removeEventListener('message', handleLinkClick);
	}, [linkMessageChannel, mail.id, playground, playgroundScope]);

	return (
		<>
			<VStack
				className={css.mailPreview}
				spacing={4}
				justify="flex-start"
			>
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
					<>
						{/* A sandboxed srcDoc cannot load Playground resources
						    through the service worker. The CSP blocks scripts. */}
						<iframe
							ref={htmlPreviewRef}
							className={css.htmlPreview}
							title={`Contents of ${mail.subject}`}
							srcDoc={createEmailPreviewDocument(
								mail.html,
								linkMessageChannel
							)}
						/>
					</>
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
							<HStack
								as="ul"
								alignment="stretch"
								justify="flex-start"
								spacing={3}
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
												<AttachmentPreview
													attachment={attachment}
												/>
											</CardMedia>
											<CardBody
												className={
													css.attachmentDetails
												}
												size="xSmall"
											>
												<VStack spacing={0}>
													<Text
														className={
															css.attachmentFilename
														}
														weight={600}
														truncate
														numberOfLines={2}
														title={
															attachment.filename
														}
													>
														{attachment.filename}
													</Text>
													<Text
														className={
															css.attachmentMetadata
														}
														variant="muted"
													>
														{attachment.mimeType},{' '}
														{formatFileSize(
															attachment.size
														)}
													</Text>
												</VStack>
											</CardBody>
											<CardFooter
												className={css.attachmentFooter}
												justify="flex-start"
												size="xSmall"
											>
												<Button
													className={
														css.attachmentDownload
													}
													variant="tertiary"
													size="small"
													icon={download}
													href={attachment.dataUrl}
													download={
														attachment.filename
													}
													aria-label={`Download ${attachment.filename}`}
												>
													Download
												</Button>
											</CardFooter>
										</Card>
									</li>
								))}
							</HStack>
						</VStack>
					</>
				)}
			</VStack>
			<ConfirmDialog
				isOpen={pendingPlaygroundLink !== undefined}
				onConfirm={navigateToPendingLink}
				onCancel={cancelPendingLink}
				confirmButtonText="Go to page"
				cancelButtonText="Cancel"
				role="alertdialog"
				contentLabel="Open email link"
			>
				<span>
					This link will change the page shown in the current
					Playground.{' '}
					<Button
						variant="link"
						onClick={openPendingLinkInNewTab}
						onKeyDown={(
							event: KeyboardEvent<HTMLButtonElement>
						) => {
							if (event.key === 'Enter') {
								event.stopPropagation();
							}
						}}
					>
						Open in new tab
					</Button>
				</span>
			</ConfirmDialog>
		</>
	);
}

function isEmailLinkClickMessage(
	data: unknown,
	messageChannel: string
): data is {
	type: typeof EMAIL_LINK_CLICK_MESSAGE_TYPE;
	channel: string;
	href: string;
} {
	return (
		typeof data === 'object' &&
		data !== null &&
		(data as { type?: unknown }).type === EMAIL_LINK_CLICK_MESSAGE_TYPE &&
		(data as { channel?: unknown }).channel === messageChannel &&
		typeof (data as { href?: unknown }).href === 'string'
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
