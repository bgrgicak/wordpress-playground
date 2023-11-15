import { signal } from '@preact/signals-react';
import { usePlaygroundContext } from '../../components/playground-viewport/context';
import Modal, { defaultStyles } from '../../components/modal';
import GitHubImportForm from './form';
import { GitHubPointer } from '../analyze-github-url';

export const isGitHubImportModalOpen = signal(false);

interface GithubImportModalProps {
	onImported?: (pointer: GitHubPointer) => void;
}
export function GithubImportModal({ onImported }: GithubImportModalProps) {
	const { playground } = usePlaygroundContext();
	return (
		<Modal
			style={{
				...defaultStyles,
				content: { ...defaultStyles.content, width: 600 },
			}}
			isOpen={isGitHubImportModalOpen.value}
			onRequestClose={() => {
				isGitHubImportModalOpen.value = false;
			}}
		>
			<GitHubImportForm
				playground={playground!}
				onClose={() => {
					isGitHubImportModalOpen.value = false;
				}}
				onImported={(pointer) => {
					playground!.goTo('/');
					// eslint-disable-next-line no-alert
					alert(
						'Import finished! Your Playground site has been updated.'
					);
					isGitHubImportModalOpen.value = false;
					onImported?.(pointer);
				}}
			/>
		</Modal>
	);
}
