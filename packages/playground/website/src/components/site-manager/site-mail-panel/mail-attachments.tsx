import {
	Button,
	Card,
	CardBody,
	CardMedia,
	Icon,
	__experimentalGrid as Grid,
	__experimentalHeading as Heading,
	__experimentalText as Text,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { download, page } from '@wordpress/icons';
import type { CapturedMailAttachment } from '../../../lib/mail-capture';
import css from './style.module.css';

export function MailAttachments({
	attachments,
}: {
	attachments: CapturedMailAttachment[];
}) {
	return (
		<VStack className={css.attachments} spacing={2}>
			<Heading level={3}>
				{attachments.length === 1
					? '1 attachment'
					: `${attachments.length} attachments`}
			</Heading>
			<Grid
				as="ul"
				alignment="stretch"
				gap={3}
				templateColumns="repeat(auto-fit, minmax(min(100%, 180px), 1fr))"
				className={css.attachmentList}
				aria-label="Attachments"
			>
				{attachments.map((attachment, index) => (
					<li
						key={`${attachment.filename}-${index}`}
						className={css.attachmentItem}
					>
						<Card
							className={css.attachmentCard}
							elevation={0}
							size="small"
						>
							<CardMedia className={css.attachmentMedia}>
								<div className={css.attachmentPreview}>
									<AttachmentPreview
										attachment={attachment}
									/>
								</div>
								<VStack
									className={css.attachmentActions}
									spacing={2}
									justify="center"
								>
									<Text
										size={12}
										lineHeight="16px"
										variant="muted"
									>
										Size: {formatFileSize(attachment.size)}
									</Text>
									<Button
										className={css.attachmentDownload}
										variant="link"
										href={attachment.dataUrl}
										download={attachment.filename}
										label={`Download ${attachment.filename}`}
									>
										<Icon icon={download} size={16} />
										<span>Download</span>
									</Button>
								</VStack>
							</CardMedia>
							<CardBody
								className={css.attachmentDetails}
								size="xSmall"
							>
								<Text
									className={css.attachmentFilename}
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
			<Icon icon={page} size={32} />
		</div>
	);
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
