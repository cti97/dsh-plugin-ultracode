/**
 * Ultracode for DSH.
 *
 * The Claude Code feature this mirrors is a switch, not a tool: when it is on,
 * the model decides per task whether the work deserves a dynamic workflow of
 * parallel subagents, instead of the user asking for one. DSH already owns the
 * execution half (`workflow`); this plugin owns the decision half — the switch,
 * the trigger, the scope, and the policy text that makes the decision.
 *
 * Extension points, and why:
 * - `systemPrompt.section()` on each `agent.ctx`, so the policy is per session,
 *   re-rendered inside every assembly, and disposed with the agent. It renders
 *   `''` when inactive, which the renderer drops, so an idle session pays
 *   nothing.
 * - `agent/inbox/inserted`, because it fires before the turn opens and therefore
 *   before the first prompt assembly of that turn. `agent/pre-step` is too late:
 *   the loop assembles the prompt *before* it dispatches that waterfall.
 * - `session/event` for `turn/start` / `turn/end`: the turn number is the clock
 *   that expires a one-turn arm, so no timer is involved.
 * - `commands.register()`, for the explicit `/ultracode [on|off|status|toggle]`
 *   switch. Its `command/run` record is durable, which is how session mode is
 *   recovered after a restart without plugin-owned storage.
 *
 * @module @local/dsh-plugin-ultracode
 */

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
} from './lib/policy.js';

/** Cordis plugin name. */
export const name = 'ultracode';

/** Services this plugin cannot work without. */
export const inject = ['systemPrompt', 'tools', 'agents', 'commands'];

/** Prompt section name; unique and namespaced so it cannot shadow a host section. */
const SECTION_NAME = 'context:ultracode';

/**
 * Register the ultracode switch for every agent in this profile.
 * @param ctx - the plugin context.
 * @param rawConfig - the loader row's `config`, validated here.
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	if (!config.enabled) return;

	/** Per-session state; the session log stays the source of truth for mode. */
	const sessions = new Map();

	/**
	 * Install the per-agent prompt contribution.
	 * @param agent - the agent whose scope owns the section.
	 */
	const install = (agent) => {
		if (sessions.has(agent.id)) return;
		const record = {
			agent,
			state: initialState({
				defaultOn: config.defaultOn,
				mode: modeFromEvents(readEvents(agent), config.commandName),
			}),
			fiber: undefined,
		};
		sessions.set(agent.id, record);
		try {
			record.fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
				scope.systemPrompt.section({
					name: SECTION_NAME,
					order: scope.systemPrompt.getSectionOrder('TEAM_POLICY') + 100,
					text: () => renderSection(record.state, config, {
						workflowAvailable: scope.tools.get(config.workflowTool, agent) !== undefined,
					}),
				});
			});
		} catch (error) {
			sessions.delete(agent.id);
			ctx.logger?.warn?.(`ultracode: could not install for session ${agent.id}: ${describeError(error)}`);
		}
	};

	/**
	 * Tear down one agent's contribution.
	 * @param agentId - the session that left.
	 */
	const uninstall = (agentId) => {
		const record = sessions.get(agentId);
		if (record === undefined) return;
		sessions.delete(agentId);
		const disposal = record.fiber?.dispose?.();
		if (disposal !== undefined && typeof disposal.catch === 'function') {
			disposal.catch((error) => {
				ctx.logger?.warn?.(`ultracode: cleanup failed for session ${agentId}: ${describeError(error)}`);
			});
		}
	};

	for (const agent of ctx.agents.list()) install(agent);
	ctx.on('agent/created', ({ agent }) => {
		install(agent);
	});
	ctx.on('agent/disposed', ({ agent }) => {
		uninstall(agent.id);
	});

	/* The keyword arms one turn. Insertion order matters: this runs before the
	 * turn opens, so the armed state is visible to that turn's first assembly. */
	ctx.on('agent/inbox/inserted', ({ agent, message }) => {
		const record = sessions.get(agent.id);
		if (record === undefined || !config.keywordTrigger) return;
		if (!hasKeyword(messageText(message), config.keyword)) return;
		record.state = reduce(record.state, { kind: 'insert', armed: true });
	});

	/* Turn boundaries are the only clock: a new turn expires the previous arm. */
	ctx.on('session/event', (session, event) => {
		const record = sessions.get(session.id);
		if (record === undefined) return;
		if (event.type === 'turn/start') {
			record.state = reduce(record.state, { kind: 'turn-start', turn: event.data.turn });
		} else if (event.type === 'turn/end') {
			record.state = reduce(record.state, { kind: 'turn-end', turn: event.data.turn });
		}
	});

	ctx.effect(() => ctx.commands.register({
		name: config.commandName,
		description: 'Switch ultracode: let the agent decide per task whether to run a dynamic workflow.',
		input: { hint: '[on|off|status|toggle]' },
		handler: (invocation) => {
			const record = sessions.get(invocation.agent.id);
			const parsed = parseCommand(invocation.rawInput);
			if (record === undefined) {
				return { kind: 'error', text: 'Ultracode is not active for this session yet; send a message first, then retry.' };
			}
			if (parsed.action === 'status') {
				return {
					kind: 'success',
					text: describeStatus(record.state, config, {
						workflowAvailable: ctx.tools.get(config.workflowTool, invocation.agent) !== undefined,
					}),
				};
			}
			if (parsed.action === 'unknown') {
				return {
					kind: 'error',
					text: `Unknown argument "${parsed.argument}". Use on, off, toggle, or status.`,
				};
			}
			record.state = reduce(record.state, { kind: 'command', action: parsed.action });
			return { kind: 'success', text: describeAction(parsed.action, record.state.mode) };
		},
	}), 'ultracode: command');

	ctx.effect(() => () => {
		for (const agentId of [...sessions.keys()]) uninstall(agentId);
	}, 'ultracode: per-session sections');
}

/**
 * Read a session's own durable log for mode recovery.
 * @param agent - the agent whose session to read.
 * @returns session events, or an empty array when unavailable.
 */
function readEvents(agent) {
	try {
		return agent.session?.ownEvents?.() ?? [];
	} catch {
		return [];
	}
}

/**
 * Render an unknown error for a log line.
 * @param error - the thrown value.
 * @returns a short message.
 */
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Re-exported for tests and for callers that want the same predicates. */
export { isActive };
