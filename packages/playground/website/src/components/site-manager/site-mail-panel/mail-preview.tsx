import {
	Notice,
	__experimentalDivider as Divider,
	__experimentalHeading as Heading,
	__experimentalText as Text,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { useEffect, useRef } from 'react';
import type { CapturedMail } from '../../../lib/mail-capture';
import { createEmailPreviewDocument } from './email-preview-document';
import { MailAttachments } from './mail-attachments';
import css from './style.module.css';

export function MailPreview({ mail }: { mail: CapturedMail }) {
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
			const body = htmlPreview.contentDocument?.body;
			if (body) {
				const observer = new ResizeObserver(resizeIframe);
				observer.observe(body);
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
				const body = htmlPreview.contentDocument?.body;
				if (!body) {
					return;
				}

				const contentHeight = Math.ceil(
					Math.max(
						body.scrollHeight,
						body.offsetHeight,
						body.getBoundingClientRect().height
					)
				);
				const height = `${Math.max(1, contentHeight)}px`;
				if (htmlPreview.style.height !== height) {
					htmlPreview.style.height = height;
				}
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
					<MailAttachments attachments={mail.attachments} />
				</>
			)}
		</VStack>
	);
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
