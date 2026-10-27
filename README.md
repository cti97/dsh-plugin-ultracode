# dsh-plugin-ultracode

Claude Code's **ultracode** for DSH: the agent decides, per task, whether the
work deserves a dynamic workflow of parallel subagents — instead of waiting for
you to ask for one.

DSH already has the execution half (`workflow` tool). This plugin owns the
decision half.

---

## 1. What the original feature does

From Anthropic's announcement and the Claude Code docs:

- Dynamic workflows let Claude "write orchestration scripts that run tens to
  hundreds of parallel subagents in a single session, checking its work before
  anything reaches you" ([Introducing dynamic workflows][anthropic]).
- Normally you must ask for a workflow. **ultracode is the switch that hands
  Claude the decision**: "it sets the effort level to xhigh, while letting
  Claude decide automatically when to use a workflow to handle your task"
  ([same announcement][anthropic]).
- Later, effort and ultracode were decoupled: turning ultracode on no longer
  changes effort, and the two settings are independent ([Penchan][penchan]).
- Three activation surfaces: the word `ultracode` in a prompt (one task),
  `/effort ultracode` (the session), and `"ultracode": true` in settings
  (every session). A separate `Ultracode keyword trigger` toggle disables the
  word alone ([Penchan][penchan]).
- The trade is explicit: every task costs more tokens, takes longer, and burns
  subscription limits faster.

The distinguishing idea is not "run subagents". It is **delegation of the
judgement** — the model, not the user, decides when fan-out is worth its price.

[anthropic]: https://claude.com/resources/articles/introducing-dynamic-workflows-in-claude-code
[penchan]: https://penchan.co/en/ai/claude-code/ultracode/

---

## 2. What this plugin does

| Claude surface | This plugin |
|---|---|
| `"ultracode": true` in `settings.json` | `defaultOn: true` in the row config |
| `/effort ultracode` | `/ultracode` |
| `/effort ultracode off` | `/ultracode off` |
| `ultracode` typed in a prompt (one task) | the same word, detected before the turn opens; arms that one turn |
| `Ultracode keyword trigger` config toggle | `keywordTrigger: false` |
| Claude decides → writes a workflow script | a per-session prompt section that states the decision rule; the model then calls the existing `workflow` tool |
| ultracode forces effort to xhigh | **not copied** — deliberate; see §7 |

Nothing is faked: when the session has no `workflow` tool, the section says so
in one line and the agent works serially instead of imitating a workflow.

---

## 3. Use it

```
/ultracode              # on for this session
/ultracode off          # off again
/ultracode toggle       # flip
/ultracode status       # what is on, and whether the workflow tool exists
```

Or just type the word:

```
ultracode: audit this repo for unsafe deserialization and only report what you can reproduce
```

The turn that contains the word gets the policy; the next turn does not. The
switch is per session, so one long session can be ultracode-on for a migration
and back off for a typo fix.

The agent states its decision in one line before acting — "workflow: 40 files,
independent, verifying each" or "serial: one file, no fan-out" — so you can see
the trade it made. When it does fan out, the policy requires named phases,
self-contained agent prompts, a verification phase that tries to refute the
first phase, and one synthesis at the end.

---

## 4. Configuration

Every key is optional; defaults live in `lib/policy.js` (`DEFAULT_CONFIG`) and
are overridden in your profile's `cordis.patch.yml` under the `ultracode` row.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the plugin itself. |
| `defaultOn` | `false` | Start each new session in ultracode. |
| `keyword` | `"ultracode"` | The word that arms one turn. Matched as a standalone token, case-insensitively; punctuation is safe. |
| `keywordTrigger` | `true` | Set `false` to keep the command but ignore the word. |
| `commandName` | `"ultracode"` | Rename the slash command, e.g. `ultra`. |
| `workflowTool` | `"workflow"` | Tool name probed before the policy claims fan-out is possible. |

Example override in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: ultracode
  config:
    defaultOn: true
    keyword: ultra
```

---

## 5. How it works

| Requirement | How the code enforces it |
|---|---|
| The policy is per session and disappears with the agent | the prompt section is registered on `agent.ctx` (`index.js` `install`) |
| An idle session pays nothing | `renderSection` returns `''` when inactive, and the prompt renderer drops empty sections (`dsh-system-prompt` `renderPrompt`) |
| The keyword affects the turn it appears in | `agent/inbox/inserted` fires before the turn opens, which is before that turn's `systemPrompt.assemble()`; `agent/pre-step` would be too late, because `preStep` assembles the prompt *before* dispatching that waterfall |
| A one-turn arm expires without a timer | the fold in `reduce` compares `armedTurn` with `currentTurn`; `turn/start` advances the clock, so turn N+1 is already disarmed |
| Mid-turn input arms the turn it belongs to | `reduce({kind:'insert'})` uses the running `currentTurn` when a turn is open |
| Session mode survives restart and resume | mode is rebuilt from the durable `command/run` records with `modeFromEvents`; the plugin stores nothing of its own |
| No fan-out claim when the tool is absent | the section provider probes `tools.get(workflowTool, agent)` on every assembly and renders the unavailable variant |
| Unload leaves no registrations | the per-agent fiber is disposed on `agent/disposed` and on plugin teardown |

The prompt text lives in `lib/policy.js` and is a plain string join, so it can be
reviewed and tested without a running Harness. There are no `{{` sequences in
it: the prompt renderer treats those as variables and would throw.

---

## 6. Verification

```
cd dsh-plugin-ultracode && npm test
```

25 tests, `node:test`, no dependencies:

- `test/policy.test.js` — config normalization, keyword boundaries (including
  `ultracodes`, `my-ultracode-tool`, `xultracode` rejected), message flattening,
  command parsing, the one-turn arm expiring across turns, mid-turn insertion,
  reference-preserving `reduce`, log recovery, and the rendered text (active,
  inactive, unavailable, session vs turn scope).
- `test/wiring.test.js` — a fake Cordis context asserts exactly one section at
  order 700, one command, the four listeners, install-once semantics,
  disposal on `agent/disposed` and on unload, agents that existed before load,
  and `enabled: false` installing nothing.

What the tests do **not** cover: real Cordis dispatch, real session-log append,
or what the model does with the policy. Those were checked by installing the
bundle into the `web` profile and exercising it in a live session.

---

## 7. Deliberate differences from Claude's version

- **Effort is not forced.** Current ultracode no longer sets effort to xhigh;
  keeping the two independent matches today's behaviour and avoids request
  failures on models whose adapter rejects a given effort id. Set effort
  yourself if you want deeper per-step reasoning.
- **No per-task keyword counter or `/config` UI.** The keyword trigger and the
  session switch are the two surfaces; both are config/command-driven.
- **Scope is the session, not the profile UI.** Ultracode is visible through
  `/ultracode status` rather than a composer badge. A client-half badge is the
  obvious next step, and would need a wire projection to carry the in-memory
  state to the browser.

---

## 8. Install

The bundle is installed into the current profile with the Harness plugin
manager, not by hand-editing `package.json`:

```
plugin_manager install_bundle  @local/dsh-plugin-ultracode
```

Local directory installs link the checkout, so edits here go live on the next
profile reload.

## 9. Layout

```
index.js              Host plugin: listeners, command, per-agent section
lib/policy.js         Pure policy: config, keyword, state fold, prompt text
cordis.patch.yml      Bundle patch: the ultracode row
locale/{en,zh}.json   Plugin Manager title and description
icon.svg              Original artwork for the plugin row
test/                 node:test suites
```
