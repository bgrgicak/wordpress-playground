import type { PHPResponse, UniversalPHP } from '@php-wasm/universal';
import { logger } from '@php-wasm/logger';
/** @ts-ignore */
import logSqlQueries from './sync-mu-plugin.php?raw';
import { phpVar, phpVars } from '@php-wasm/util';

export async function installSqlSyncMuPlugin(playground: UniversalPHP) {
	if (!(await playground.fileExists('/wordpress/wp-content/mu-plugins'))) {
		await playground.mkdir('/wordpress/wp-content/mu-plugins');
	}
	await playground.writeFile(
		`/wordpress/wp-content/mu-plugins/sync-mu-plugin.php`,
		logSqlQueries
	);
}

export async function overrideAutoincrementSequences(
	playground: UniversalPHP,
	baseOffset: number,
	knownIds: Record<string, number> = {}
) {
	const initializationResult = await playground.run({
		code: `<?php
		// Use a file-based flag instead of define() because PHP
		// constants persist across playground.run() calls in WASM.
		file_put_contents('/tmp/REPLAYING_SQL', '1');
        require '/wordpress/wp-load.php';
        playground_sync_override_autoincrement_algorithm(
			${phpVar(baseOffset)},
			${phpVar(knownIds)}
		);
		@unlink('/tmp/REPLAYING_SQL');
	    `,
	});
	assertEmptyOutput(initializationResult, 'Initialization failed.');

	// Get the current autoincrement ID value for all tables
	const response = await playground.run({
		code: `<?php
		file_put_contents('/tmp/REPLAYING_SQL', '1');
        require '/wordpress/wp-load.php';
		$data = $GLOBALS['@pdo']
			->query('SELECT * FROM playground_sequence')
			->fetchAll(PDO::FETCH_KEY_PAIR);
		echo json_encode($data);
		@unlink('/tmp/REPLAYING_SQL');
		`,
	});
	return response.json;
}

/**
 * Listens to SQL queries and transactions on a PlaygroundClient instance,
 * and records them in a journal. When a transaction is committed, the
 * provided callback is called for every query in the transaction.
 *
 * @param playground The PlaygroundClient instance to listen to.
 * @param onCommit The callback to invoke when a transaction is committed.
 */
export async function journalSQLQueries(
	playground: UniversalPHP,
	onCommit: (queries: SQLJournalEntry) => void
) {
	let activeTransaction: SQLJournalEntry[] | null = null;

	// When PHP request terminates, any uncommitted
	// queries in the active transaction are rolled back.
	playground.addEventListener('request.end', () => {
		activeTransaction = null;
	});
	playground.onMessage(async (messageString: string) => {
		const message = JSON.parse(messageString) as any;
		if (message?.type !== 'sql') {
			return;
		}
		if (message.subtype === 'transaction') {
			const command = message as SQLTransactionCommand;
			if (!command.success) {
				return;
			}
			switch (command.command) {
				case 'START TRANSACTION':
					activeTransaction = [];
					break;
				case 'COMMIT':
					if (activeTransaction?.length) {
						activeTransaction.forEach(onCommit);
					}
					activeTransaction = null;
					break;
				case 'ROLLBACK':
					activeTransaction = null;
					break;
			}
			return;
		}

		if (
			message.subtype === 'replay-query' ||
			message.subtype === 'reconstruct-insert'
		) {
			const entry = message as SQLJournalEntry;
			if (activeTransaction) {
				activeTransaction.push(entry);
			} else {
				onCommit(entry);
			}
		}
	});
}

export async function replaySQLJournal(
	playground: UniversalPHP,
	journal: SQLJournalEntry[]
) {
	const js = phpVars({ journal });
	const result = await playground.run({
		code: `<?php
		// Use a file-based flag instead of define() because PHP
		// constants persist across playground.run() calls in WASM,
		// which permanently disables the SQL journal hooks.
		file_put_contents('/tmp/REPLAYING_SQL', '1');

		// Only load WordPress and replay the SQL queries now
		require '/wordpress/wp-load.php';
		playground_sync_replay_sql_journal(${js.journal});

		// Remove the flag so the next run() can journal normally
		@unlink('/tmp/REPLAYING_SQL');
	`,
	});
	assertEmptyOutput(result, 'Replay error.');
}

function assertEmptyOutput(result: PHPResponse, errorMessage: string) {
	if (result.text.trim() || result.errors.trim()) {
		logger.error({
			text: result.text,
			errors: result.errors,
		});
		throw new Error(`${errorMessage}. See the console for more details.`);
	}
}

export type ReplayQuery = {
	type: 'sql';
	subtype: 'replay-query';
	query: string;
	query_type: string;
	table_name: string;
	auto_increment_column: string;
	last_insert_id: number;
};

export type ReconstructInsert = {
	type: 'sql';
	subtype: 'reconstruct-insert';
	query_type: 'INSERT';
	row: Record<string, string | number | null>;
	table_name: string;
	auto_increment_column: string;
	last_insert_id: number;
};

export type SQLJournalEntry = ReplayQuery | ReconstructInsert;

export type SQLTransactionCommand =
	| {
			type: 'sql';
			subtype: 'transaction';
			command: 'START TRANSACTION';
			success: boolean;
	  }
	| {
			type: 'sql';
			subtype: 'transaction';
			command: 'COMMIT';
			success: boolean;
	  }
	| {
			type: 'sql';
			subtype: 'transaction';
			command: 'ROLLBACK';
			success: boolean;
	  };
