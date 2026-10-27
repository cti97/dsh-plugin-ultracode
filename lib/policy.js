/**
 * Pure ultracode policy.
 *
 * Nothing in this module touches Cordis, the session log, or the filesystem:
 * it maps (config, state, events) to state and to prompt text, so the whole
 * decision surface is unit-testable without a running Harness.
 *
 * @module @local/dsh-plugin-ultracode/policy
 */

/** Config defaults, also the normalization target. */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	defaultOn: false,
	keyword: 'ultracode',
	keywordTrigger: true,
	commandName: 'ultracode',
	workflowTool: 'workflow',
});

/** Longest accepted keyword, in characters. */
const MAX_KEYWORD_LENGTH = 40;

/** Command names the Harness accepts. */
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Normalize a raw bundle `config` block.
 *
 * The plugin exports no `Config` schema (that would need a runtime dependency
 * this package deliberately does not take), so validation lives here and a
 * bad value fails the row loud instead of silently disabling the feature.
 *
 * @param raw - the loader row's config object, possibly absent or partial.
 * @returns a complete config.
 */
export function normalizeConfig(raw) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : DEFAULT_CONFIG.keyword;
	if (keyword.length === 0) throw new Error('ultracode: keyword must be a non-empty string');
	if (keyword.length > MAX_KEYWORD_LENGTH) {
		throw new Error(`ultracode: keyword must be at most ${MAX_KEYWORD_LENGTH} characters`);
	}
	const commandName = typeof input.commandName === 'string' ? input.commandName.trim() : DEFAULT_CONFIG.commandName;
	if (!COMMAND_NAME.test(commandName)) {
		throw new Error(`ultracode: commandName must match ${String(COMMAND_NAME)}`);
	}
	const workflowTool = typeof input.workflowTool === 'string' && input.workflowTool.trim().length > 0
		? input.workflowTool.trim()
		: DEFAULT_CONFIG.workflowTool;
	return {
		enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
		defaultOn: input.defaultOn ?? DEFAULT_CONFIG.defaultOn,
		keyword,
		keywordTrigger: input.keywordTrigger ?? DEFAULT_CONFIG.keywordTrigger,
		commandName,
		workflowTool,
	};
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param text - literal text.
 * @returns the escaped text.
 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether prose contains the trigger keyword as a standalone word.
 *
 * `ultracode`, `Ultracode:`, and `please ultracode this` match; `ultracodes`,
 * `my-ultracode-tool`, and `xultracode` do not. Surrounding characters may be
 * anything that is not a letter, digit, underscore, or hyphen, so the check
 * stays correct for keywords containing punctuation or spaces.
 *
 * @param text - flattened message text.
 * @param keyword - the configured keyword.
 * @returns true when the keyword appears as a standalone token.
 */
export function hasKeyword(text, keyword) {
	if (typeof text !== 'string' || text.length === 0) return false;
	const pattern = new RegExp(
		`(?:^|[^\\p{L}\\p{N}_-])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}_-])`,
		'iu',
	);
	return pattern.test(text);
}

/**
 * Flatten one message's content into plain text.
 *
 * Content arrives either as a string or as content blocks; only text blocks
 * carry prose, so images, files, and tool calls contribute nothing.
 *
 * @param message - a message-like object.
 * @returns the concatenated text, or an empty string.
 */
export function messageText(message) {
	if (message === null || typeof message !== 'object') return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type !== undefined && block.type !== 'text') continue;
		if (typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n');
}

/**
 * Parse the argument tail of the toggle command.
 * @param rawInput - everything after the command name.
 * @returns `{ action }` with one of `on`, `off`, `toggle`, `status`, `unknown`.
 */
export function parseCommand(rawInput) {
	const argument = (rawInput ?? '').trim().toLowerCase();
	if (argument === '' || argument === 'on' || argument === 'enable' || argument === 'true' || argument === '1') {
		return { action: 'on' };
	}
	if (argument === 'off' || argument === 'disable' || argument === 'false' || argument === '0') {
		return { action: 'off' };
	}
	if (argument === 'toggle') return { action: 'toggle' };
	if (argument === 'status' || argument === '?') return { action: 'status' };
	return { action: 'unknown', argument };
}

/**
 * Rebuild the session mode from durable command records.
 *
 * `command/run` is written to the session log, so the mode survives a restart
 * and a resumed session without any plugin-owned storage. Compaction can drop
 * old records; the fallback is then the configured default.
 *
 * @param events - session events, oldest first.
 * @param commandName - this plugin's command name.
 * @returns `'on'`, `'off'`, or `undefined` when the log holds no such command.
 */
export function modeFromEvents(events, commandName) {
	let mode;
	if (!Array.isArray(events)) return mode;
	for (const event of events) {
		if (event === null || typeof event !== 'object' || event.type !== 'command/run') continue;
		const data = event.data;
		if (data === null || typeof data !== 'object' || data.name !== commandName) continue;
		const parsed = parseCommand(data.args);
		if (parsed.action === 'on') mode = 'on';
		else if (parsed.action === 'off') mode = 'off';
		else if (parsed.action === 'toggle') mode = mode === 'on' ? 'off' : 'on';
	}
	return mode;
}

/**
 * Build the starting state for one session.
 * @param options - `defaultOn` from config and `mode` recovered from the log.
 * @returns a fresh state.
 */
export function initialState({ defaultOn, mode }) {
	return {
		mode: mode ?? (defaultOn ? 'on' : 'off'),
		currentTurn: -1,
		armedTurn: -1,
		pendingArm: false,
		running: false,
	};
}

/**
 * Fold one observed fact into the state.
 *
 * Pure: an event the state ignores returns the same reference, so callers can
 * detect "nothing changed" cheaply. The turn number is the only clock, which
 * is what makes the one-turn arm expire without a timer.
 *
 * @param state - current state.
 * @param event - one of `turn-start`, `turn-end`, `insert`, `command`.
 * @returns the next state, or `state` itself when nothing changed.
 */
export function reduce(state, event) {
	switch (event.kind) {
		case 'turn-start': {
			const armedTurn = state.pendingArm ? event.turn : state.armedTurn;
			return {
				...state,
				currentTurn: event.turn,
				armedTurn,
				pendingArm: false,
				running: true,
			};
		}
		case 'turn-end':
			return state.running ? { ...state, running: false } : state;
		case 'insert': {
			if (event.armed !== true) return state;
			/* A message inserted mid-turn belongs to that turn, so arm it now.
			 * Before a turn opens it is claimed at `turn-start`. */
			if (state.running && state.currentTurn >= 0) {
				return { ...state, armedTurn: state.currentTurn };
			}
			return { ...state, pendingArm: true };
		}
		case 'command': {
			const mode = event.action === 'toggle' ? (state.mode === 'on' ? 'off' : 'on') : event.action;
			return mode === state.mode ? state : { ...state, mode };
		}
		default:
			return state;
	}
}

/**
 * Whether the policy is in force right now.
 * @param state - current state.
 * @returns true for a session-wide on, or for the single armed turn.
 */
export function isActive(state) {
	if (state.mode === 'on') return true;
	return state.running && state.armedTurn >= 0 && state.armedTurn === state.currentTurn;
}

/** First paragraph: what the mode asks of the model. */
const HEADER = [
	'# Ultracode',
	'',
	'Ultracode is a mode the user enabled. It delegates one decision to you: whether this task deserves a dynamic workflow — an orchestration script that runs many subagents in parallel — instead of ordinary serial turns.',
	'Decide it yourself. Do not ask, and do not wait for the user to say the word workflow.',
].join('\n');

/** Session-wide scope line. */
const SCOPE_SESSION = 'It stays on for the whole session, so the decision applies to every task until the user turns it off.';

/** One-turn scope line. */
const SCOPE_TURN = 'It is armed for this turn only; later turns return to normal unless the user asks for ultracode again.';

/** When to fan out. */
const DECISION = [
	'Decide before your first substantive action, and state the decision in one line: workflow or serial, and why.',
	'',
	'Run a workflow when the work splits into many independent units whose results you would verify separately: a bug hunt or security review across a service or repository, a migration or language port that touches many files, a review from several genuinely independent angles, research swept across many sources, or a hard problem worth several independent attempts with adversarial refutation.',
	'The signal is parallel structure plus a high cost of being wrong.',
].join('\n');

/** When not to fan out. */
const RESTRAINT = [
	'Stay serial when: one continuous line of reasoning carries the task, such as a single edit, one file, or a proof; the units are sequential, so each needs the previous result; you would only send the same prompt to many agents with no distinct input and no verification step; or the coordination cost exceeds the work itself.',
	'Small tasks are not worth a workflow — on a small task a workflow is a slower, more expensive route to the same answer.',
].join('\n');

/** How to build the script. */
const RUNNING = [
	'When you run one: name its phases; give every agent a self-contained prompt, because it does not see this conversation; fan out per unit, never per fragment; pass structured results instead of prose dumps; add a verification phase whose agents try to refute what the first phase found, and report what survived; synthesise once, here, at the end.',
].join('\n');

/** Cost honesty. */
const BUDGET = 'Budget is real: a workflow costs far more tokens and wall-clock than serial turns, and the user pays for it. Prefer one workflow that covers the task over several small ones.';

/** Rendered when ultracode is requested but the session has no workflow tool. */
const UNAVAILABLE = [
	'# Ultracode',
	'',
	'Ultracode is on, but this session has no workflow tool, so fanning out subagents is not available.',
	'Do the work serially and say so in one short line instead of imitating a workflow.',
].join('\n');

/**
 * Render the prompt section for the current state.
 *
 * Returns `''` when inactive: the prompt renderer drops empty sections, so an
 * idle session pays nothing for this plugin.
 *
 * @param state - current state.
 * @param config - normalized config.
 * @param options - `workflowAvailable` for this assembly.
 * @returns the section text, possibly empty.
 */
export function renderSection(state, config, options) {
	if (!isActive(state)) return '';
	if (options?.workflowAvailable !== true) return UNAVAILABLE;
	const scope = state.mode === 'on' ? SCOPE_SESSION : SCOPE_TURN;
	return [HEADER, scope, DECISION, RESTRAINT, RUNNING, BUDGET].join('\n\n');
}

/**
 * One-line description of the state, for the command's status output.
 *
 * @param state - current state.
 * @param config - normalized config.
 * @param options - `workflowAvailable` and `recovered` (mode came from the log).
 * @returns human-readable status text.
 */
export function describeStatus(state, config, options) {
	const active = state.mode === 'on';
	const lines = [
		`Ultracode: ${active ? 'on for this session' : 'off for this session'}.`,
		`Keyword trigger: ${config.keywordTrigger ? `"${config.keyword}" (arms the turn it appears in)` : 'disabled'}.`,
		`Workflow tool: ${options?.workflowAvailable === true ? `"${config.workflowTool}" is available` : 'not available — ultracode cannot fan out in this session'}.`,
	];
	if (state.armedTurn >= 0 && state.armedTurn === state.currentTurn) {
		lines.push(`Armed for turn ${state.currentTurn}.`);
	}
	if (active) lines.push('Turn it off with this command and the argument "off".');
	return lines.join('\n');
}

/**
 * Confirmation text for a state change.
 * @param action - the accepted action.
 * @param mode - the mode after the change.
 * @returns human-readable confirmation.
 */
export function describeAction(action, mode) {
	const suffix = mode === 'on'
		? 'The agent now decides per task whether to run a dynamic workflow, and says which it chose.'
		: 'The agent is back to ordinary serial work and will only fan out if you ask for it.';
	const verb = action === 'toggle' ? `Ultracode toggled ${mode}.` : `Ultracode ${mode}.`;
	return `${verb} ${suffix}`;
}
