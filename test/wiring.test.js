import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name } from '../index.js';

/**
 * Build a fake Cordis context that records what the plugin registers.
 * @param options - `events` returned by each fake agent's session and
 *   `workflowAvailable` for the tool lookup.
 * @returns the context, the recording of registrations, and a factory for agents.
 */
function fakeHost({ workflowAvailable = true, ownEvents = [] } = {}) {
	const registered = {
		events: new Map(),
		commands: [],
		sections: [],
		effects: [],
		disposedFibers: 0,
	};
	const agents = [];

	const makeScope = (agent) => ({
		systemPrompt: {
			getSectionOrder: () => 600,
			section: (definition) => {
				registered.sections.push({ agent, definition });
				return () => {};
			},
		},
		tools: { get: () => (workflowAvailable ? { name: 'workflow' } : undefined) },
	});

	const makeAgent = (id) => {
		const agent = {
			id,
			session: { ownEvents: () => ownEvents },
			ctx: {
				inject: (_deps, callback) => {
					callback(makeScope(agent));
					return {
						dispose: async () => {
							registered.disposedFibers += 1;
						},
					};
				},
			},
		};
		agents.push(agent);
		return agent;
	};

	const ctx = {
		logger: { warn: () => {} },
		agents: { list: () => [...agents] },
		tools: { get: () => (workflowAvailable ? { name: 'workflow' } : undefined) },
		on: (event, handler) => {
			registered.events.set(event, handler);
			return () => {};
		},
		effect: (factory) => {
			const disposer = factory();
			registered.effects.push(disposer);
			return () => {};
		},
		commands: {
			register: (definition) => {
				registered.commands.push(definition);
				return () => {};
			},
		},
	};

	return { ctx, registered, makeAgent };
}

test('the bundle exports a coherent row', () => {
	assert.equal(name, 'ultracode');
	assert.deepEqual([...inject].sort(), ['agents', 'commands', 'systemPrompt', 'tools']);
});

test('apply registers one section, one command, and the three listeners', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });

	assert.equal(registered.sections.length, 1);
	const [entry] = registered.sections;
	assert.equal(entry.definition.name, 'context:ultracode');
	assert.equal(entry.definition.order, 700);
	assert.equal(typeof entry.definition.text, 'function');

	assert.equal(registered.commands.length, 1);
	assert.equal(registered.commands[0].name, 'ultracode');
	assert.deepEqual(registered.commands[0].input, { hint: '[on|off|status|toggle]' });

	for (const event of ['agent/created', 'agent/disposed', 'agent/inbox/inserted', 'session/event']) {
		assert.equal(typeof registered.events.get(event), 'function', `listens to ${event}`);
	}
});

test('an idle session renders no section at all', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });

	assert.equal(registered.sections[0].definition.text(), '');
});

test('a keyword in a prompt arms that turn and then expires', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });

	registered.events.get('agent/inbox/inserted')({
		agent,
		message: { content: [{ type: 'text', text: 'ultracode: audit this repo' }] },
	});
	assert.equal(registered.sections[0].definition.text(), '', 'no turn is open yet');

	registered.events.get('session/event')(
		{ id: 'a1' },
		{ type: 'turn/start', data: { turn: 1 } },
	);
	assert.match(registered.sections[0].definition.text(), /this turn only/);

	registered.events.get('session/event')({ id: 'a1' }, { type: 'turn/end', data: { turn: 1 } });
	assert.equal(registered.sections[0].definition.text(), '');

	registered.events.get('session/event')({ id: 'a1' }, { type: 'turn/start', data: { turn: 2 } });
	assert.equal(registered.sections[0].definition.text(), '', 'the arm applied to turn 1 only');
});

test('the command switches session mode and reports status', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });
	const command = registered.commands[0];
	const invoke = (rawInput) => command.handler({ agent, rawInput });

	assert.match(invoke('status').text, /off for this session/);
	assert.match(invoke('on').text, /Ultracode on\./);
	assert.match(registered.sections[0].definition.text(), /whole session/);

	const status = invoke('status');
	assert.equal(status.kind, 'success');
	assert.match(status.text, /on for this session/);

	assert.match(invoke('toggle').text, /toggled off/);
	assert.equal(registered.sections[0].definition.text(), '');

	assert.match(invoke('off').text, /Ultracode off\./);
	assert.equal(invoke('bogus').kind, 'error');
});

test('the command refuses an agent it never installed', () => {
	const { ctx, registered } = fakeHost();
	apply(ctx, {});
	const result = registered.commands[0].handler({ agent: { id: 'ghost' }, rawInput: 'on' });
	assert.equal(result.kind, 'error');
	assert.match(result.text, /not active for this session/);
});

test('a session recovers its mode from its own durable command log', () => {
	const { ctx, registered, makeAgent } = fakeHost({
		ownEvents: [{ type: 'command/run', data: { name: 'ultracode', args: 'on' } }],
	});
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });
	assert.match(registered.sections[0].definition.text(), /whole session/);
});

test('defaultOn starts every session armed for the whole session', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, { defaultOn: true });
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });
	assert.match(registered.sections[0].definition.text(), /whole session/);
});

test('a missing workflow tool degrades honestly instead of lying', () => {
	const { ctx, registered, makeAgent } = fakeHost({ workflowAvailable: false });
	apply(ctx, { defaultOn: true });
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });
	assert.match(registered.sections[0].definition.text(), /no workflow tool/);
});

test('disabled config installs nothing', () => {
	const { ctx, registered } = fakeHost();
	apply(ctx, { enabled: false });
	assert.equal(registered.sections.length, 0);
	assert.equal(registered.commands.length, 0);
	assert.equal(registered.events.size, 0);
});

test('agents are installed once and disposed on unload', () => {
	const { ctx, registered, makeAgent } = fakeHost();
	apply(ctx, {});
	const agent = makeAgent('a1');
	registered.events.get('agent/created')({ agent });
	registered.events.get('agent/created')({ agent });
	registered.events.get('agent/disposed')({ agent });
	assert.equal(registered.disposedFibers, 1);

	// Unloading the plugin disposes what is left.
	const other = makeAgent('a2');
	registered.events.get('agent/created')({ agent: other });
	for (const effect of registered.effects) {
		if (typeof effect === 'function') effect();
	}
	assert.equal(registered.disposedFibers, 2);
});

test('agents that already existed when the plugin loaded are installed too', () => {
	const { ctx, registered } = fakeHost();
	// Simulate a live agent created before apply() ran.
	const agent = {
		id: 'pre',
		session: { ownEvents: () => [] },
		ctx: {
			inject: (_deps, callback) => {
				callback({
					systemPrompt: { getSectionOrder: () => 600, section: (d) => { registered.sections.push({ agent: null, definition: d }); return () => {}; } },
					tools: { get: () => ({}) },
				});
				return { dispose: async () => {} };
			},
		},
	};
	ctx.agents.list = () => [agent];
	apply(ctx, { defaultOn: true });
	assert.equal(registered.sections.length, 1);
	assert.match(registered.sections[0].definition.text(), /whole session/);
});
