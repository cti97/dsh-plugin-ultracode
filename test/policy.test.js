import assert from 'node:assert/strict';
import test from 'node:test';

import {
	describeAction,
	describeStatus,
	hasKeyword,
	initialState,
	isActive,
	messageText,
	modeFromEvents,
	normalizeConfig,
	parseCommand,
	reduce,
	renderSection,
} from '../lib/policy.js';

test('normalizeConfig fills defaults and rejects bad values', () => {
	const defaults = normalizeConfig(undefined);
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.defaultOn, false);
	assert.equal(defaults.keyword, 'ultracode');
	assert.equal(defaults.keywordTrigger, true);
	assert.equal(defaults.commandName, 'ultracode');
	assert.equal(defaults.workflowTool, 'workflow');

	assert.equal(normalizeConfig({ defaultOn: true }).defaultOn, true);
	assert.equal(normalizeConfig({ keyword: '  turbo  ' }).keyword, 'turbo');

	assert.throws(() => normalizeConfig({ keyword: '   ' }), /non-empty/);
	assert.throws(() => normalizeConfig({ keyword: 'x'.repeat(41) }), /at most/);
	assert.throws(() => normalizeConfig({ commandName: 'Ultra Code' }), /commandName/);
});

test('hasKeyword matches standalone words only', () => {
	assert.equal(hasKeyword('ultracode', 'ultracode'), true);
	assert.equal(hasKeyword('Ultracode: port this', 'ultracode'), true);
	assert.equal(hasKeyword('please ultracode this repo', 'ultracode'), true);
	assert.equal(hasKeyword('use it (ultracode) now', 'ultracode'), true);

	assert.equal(hasKeyword('ultracodes are not a thing', 'ultracode'), false);
	assert.equal(hasKeyword('my-ultracode-tool', 'ultracode'), false);
	assert.equal(hasKeyword('xultracode', 'ultracode'), false);
	assert.equal(hasKeyword('', 'ultracode'), false);
	assert.equal(hasKeyword(undefined, 'ultracode'), false);
});

test('hasKeyword escapes punctuation in custom keywords', () => {
	assert.equal(hasKeyword('run v2.0 now', 'v2.0'), true);
	assert.equal(hasKeyword('run v2x0 now', 'v2.0'), false);
	assert.equal(hasKeyword('go a+b', 'a+b'), true);
});

test('messageText flattens text blocks and ignores non-text media', () => {
	assert.equal(messageText({ content: 'plain' }), 'plain');
	assert.equal(
		messageText({
			content: [
				{ type: 'text', text: 'first' },
				{ type: 'image', attachment: { id: 'x' } },
				{ type: 'text', text: 'second' },
			],
		}),
		'first\nsecond',
	);
	assert.equal(messageText({ content: [{ type: 'image' }] }), '');
	assert.equal(messageText(null), '');
	assert.equal(messageText({ content: 42 }), '');
});

test('parseCommand reads the argument tail', () => {
	assert.deepEqual(parseCommand(''), { action: 'on' });
	assert.deepEqual(parseCommand('  ON '), { action: 'on' });
	assert.deepEqual(parseCommand('off'), { action: 'off' });
	assert.deepEqual(parseCommand('disable'), { action: 'off' });
	assert.deepEqual(parseCommand('toggle'), { action: 'toggle' });
	assert.deepEqual(parseCommand('status'), { action: 'status' });
	assert.deepEqual(parseCommand('nonsense'), { action: 'unknown', argument: 'nonsense' });
	assert.deepEqual(parseCommand(null), { action: 'on' });
});

test('a keyword arms exactly one turn', () => {
	let state = initialState({ defaultOn: false, mode: undefined });
	assert.equal(isActive(state), false);

	state = reduce(state, { kind: 'insert', armed: true });
	assert.equal(state.pendingArm, true);
	// Insertion alone does not activate: no turn is running yet.
	assert.equal(isActive(state), false);

	state = reduce(state, { kind: 'turn-start', turn: 1 });
	assert.equal(isActive(state), true, 'armed turn is active');
	assert.equal(state.armedTurn, 1);

	state = reduce(state, { kind: 'turn-end', turn: 1 });
	assert.equal(isActive(state), false, 'a closed turn is never active');

	state = reduce(state, { kind: 'turn-start', turn: 2 });
	assert.equal(isActive(state), false, 'the arm expired with turn 1');
});

test('a keyword inserted mid-turn arms that turn, not the next one', () => {
	let state = initialState({ defaultOn: false, mode: undefined });
	state = reduce(state, { kind: 'turn-start', turn: 4 });
	state = reduce(state, { kind: 'insert', armed: true });
	assert.equal(state.pendingArm, false);
	assert.equal(state.armedTurn, 4);
	assert.equal(isActive(state), true);

	state = reduce(state, { kind: 'turn-start', turn: 5 });
	assert.equal(isActive(state), false);
});

test('reduce keeps the same reference when nothing changes', () => {
	const state = initialState({ defaultOn: false, mode: undefined });
	assert.equal(reduce(state, { kind: 'insert', armed: false }), state);
	assert.equal(reduce(state, { kind: 'turn-end', turn: 1 }), state);
	assert.equal(reduce(state, { kind: 'unknown' }), state);

	const on = initialState({ defaultOn: true, mode: undefined });
	assert.equal(reduce(on, { kind: 'command', action: 'on' }), on);
});

test('session mode follows commands and toggles', () => {
	let state = initialState({ defaultOn: false, mode: undefined });
	assert.equal(state.mode, 'off');

	state = reduce(state, { kind: 'command', action: 'on' });
	assert.equal(state.mode, 'on');
	assert.equal(isActive(state), true, 'session mode needs no turn');

	state = reduce(state, { kind: 'command', action: 'toggle' });
	assert.equal(state.mode, 'off');

	state = reduce(state, { kind: 'turn-start', turn: 3 });
	state = reduce(state, { kind: 'turn-end', turn: 3 });
	assert.equal(isActive(state), false);
});

test('modeFromEvents replays the durable command log', () => {
	const run = (args) => ({ type: 'command/run', data: { name: 'ultracode', args } });
	const events = [
		{ type: 'turn/start', data: { turn: 1 } },
		run('on'),
		{ type: 'tool/call', data: {} },
		run('off'),
		{ type: 'command/run', data: { name: 'other', args: 'on' } },
	];
	assert.equal(modeFromEvents(events, 'ultracode'), 'off');
	assert.equal(modeFromEvents([run('on')], 'ultracode'), 'on');
	assert.equal(modeFromEvents([run('on'), run('toggle')], 'ultracode'), 'off');
	assert.equal(modeFromEvents([run('status')], 'ultracode'), undefined);
	assert.equal(modeFromEvents([], 'ultracode'), undefined);
	assert.equal(modeFromEvents(undefined, 'ultracode'), undefined);
});

test('renderSection is empty when inactive and complete when active', () => {
	const config = normalizeConfig(undefined);
	const idle = initialState({ defaultOn: false, mode: undefined });
	assert.equal(renderSection(idle, config, { workflowAvailable: true }), '');

	const session = initialState({ defaultOn: true, mode: undefined });
	const text = renderSection(session, config, { workflowAvailable: true });
	assert.match(text, /Ultracode is a mode the user enabled/);
	assert.match(text, /whole session/);
	assert.match(text, /Stay serial when/);
	assert.match(text, /verification phase/);
	assert.match(text, /Budget is real/);
	assert.doesNotMatch(text, /this turn only/);
	// No prompt-variable delimiters: the renderer would throw on a stray "{{".
	assert.equal(text.includes('{{'), false);
	assert.equal(text.includes('}}'), false);

	const armed = reduce(
		reduce(initialState({ defaultOn: false, mode: undefined }), { kind: 'insert', armed: true }),
		{ kind: 'turn-start', turn: 1 },
	);
	const turnText = renderSection(armed, config, { workflowAvailable: true });
	assert.match(turnText, /this turn only/);
	assert.doesNotMatch(turnText, /whole session/);
});

test('renderSection warns instead of pretending when the tool is missing', () => {
	const config = normalizeConfig(undefined);
	const on = initialState({ defaultOn: true, mode: undefined });
	const text = renderSection(on, config, { workflowAvailable: false });
	assert.match(text, /no workflow tool/);
	assert.match(text, /serially/);
	assert.doesNotMatch(text, /Run a workflow when/);
});

test('status and confirmation text describe the live state', () => {
	const config = normalizeConfig(undefined);
	const on = initialState({ defaultOn: true, mode: undefined });
	const armed = reduce(on, { kind: 'insert', armed: true });
	const live = reduce(armed, { kind: 'turn-start', turn: 7 });

	const status = describeStatus(live, config, { workflowAvailable: true });
	assert.match(status, /on for this session/);
	assert.match(status, /"ultracode"/);
	assert.match(status, /"workflow" is available/);
	assert.match(status, /Armed for turn 7/);

	const unavailable = describeStatus(on, config, { workflowAvailable: false });
	assert.match(unavailable, /not available/);

	assert.match(describeAction('on', 'on'), /Ultracode on\./);
	assert.match(describeAction('toggle', 'off'), /Ultracode toggled off\./);
});
