import type { PHPResponse, UniversalPHP } from '@php-wasm/universal';
import { logger } from '@php-wasm/logger';
/** @ts-ignore */
import logSqlQueries from './sync-mu-plugin.php?raw';
import { phpVar } from '@php-wasm/util';

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
	// Write journal data to a temp file instead of inlining it
	// in the PHP code via phpVars(). The phpVars() helper uses
	// String.fromCodePoint(...bytes) which overflows the stack
	// on large payloads (serialized WP options can be 100KB+).
	const journalJson = JSON.stringify(journal);
	const encoder = new TextEncoder();
	await playground.writeFile(
		'/tmp/replay_journal.json',
		encoder.encode(journalJson)
	);

	const result = await playground.run({
		code: `<?php
		file_put_contents('/tmp/REPLAYING_SQL', '1');

		require '/wordpress/wp-load.php';
		$journal = json_decode(file_get_contents('/tmp/replay_journal.json'), true);
		playground_sync_replay_sql_journal($journal);

		@unlink('/tmp/REPLAYING_SQL');
		@unlink('/tmp/replay_journal.json');
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
