# Human in the loop: design

A Claude Code mod in which Claude assigns tasks to its user. Each task waits in the My tasks pane, counted in a status line under the prompt, until the user fulfills it or rejects it.

Status: v0.1.0 built, at `~/.claude/dev-mods/<session>/human-in-the-loop/` (16 tests pass, strict validation passes), checked against the mod API of Claude Code 2.1.288. Changes since the first draft: the tasks moved from the band above the prompt to a pane plus a status line ([The UI](#the-ui)); Accept is gone; a mid-turn Send now that the running turn refuses goes as a message the moment the turn ends. What only a live session can confirm is listed under [Spike first](#spike-first).

## The problem

Claude often needs something only the user can do: a key in `.env`, a click in a dashboard, a command on their own machine, or a decision. It says so in the middle of a reply. The user is busy correcting bugs and handing out more work, and the ask scrolls away. In the best case Claude has to keep repeating "I still need you to…". In the worst case the ask is lost.

## The idea

Claude calls `assign_task` instead of burying the ask in prose. The task stays in the My tasks pane, and in the status line's count, until the user acts on it:

- **Reject:** "I won't," with an optional reason.
- **Fulfill:** mark it Done, pick an option, or write an answer (as long as needed).

An answer goes to Claude in one of two ways:

- **Send now** delivers it as a message. This is the default when Claude is idle.
- **Save for later** keeps it on the task for Claude to pick up when it next checks. This is the default while Claude is working, so the user doesn't derail a turn they didn't mean to interrupt.

```
☐ 2 tasks for you · /my-tasks
```

## Scenarios

1. **A secret.** "Add `STRIPE_SECRET_KEY` to `.env`; the webhook test can't run without it." The user adds it and presses Done. The key itself never passes through Claude.
2. **An action only the user can take.** "Approve and run the `add_index_orders` migration on staging." The user marks it done after lunch; until then it waits in the pane.
3. **The user's machine.** "Run `xcodebuild test` on your Mac and paste the failing tests." The answer is a long paste.
4. **A decision.** "Pick a pagination strategy for /feed: cursor, or offset capped at 10k?" One keypress, or a reasoned answer.
5. **A browser.** "Open Sentry issue #4471 and paste the breadcrumbs." The answer is a long paste.
6. **Claude solves it itself.** It asked for a sample fixture, then found one in `tests/fixtures`. It withdraws the task, and the row disappears.
7. **Outside the session.** "Rotate the leaked token in Vault after the deploy." The task outlives the session and is still open in the next one in this project.

## Lifecycle

```
         done / option / answer
  open ─────────────────────────────────▶ done
    │
    ├──── reject (+ reason) ─────────────▶ rejected
    │
    └──── Claude: withdraw_task (+ reason) ▶ withdrawn
```

Every change the user makes is an **update** that Claude hasn't seen until it is delivered. Each update is delivered once, by whichever path comes first:

| Update | Claude idle | Claude working |
|---|---|---|
| Done, answered, option picked, rejected: **Send now** | `$.prompt.submit`: a turn of its own | `$.session.append` (a user row): Claude reads it at its next step |
| The same: **Save for later** | Kept on the task | Kept on the task |

Default buttons: Send now when idle, Save for later while working. Both buttons are always there, and the default one is the one Enter presses.

**Saved updates reach Claude through three paths:**

1. **`list_tasks`.** Claude queries the tasks, and everything it reads is marked delivered.
2. **The user's next prompt.** A `prompt.submit` hook attaches a digest as `context`, which the model reads and the user never sees. A short answer (≤ 400 chars) is inlined. A longer one is named, with "call list_tasks for the answer". Without this, Claude would never know there is something to query.
3. **A compaction or resume.** A `prompt.context` block lists the open tasks and undelivered updates. The engine re-reads that block on compaction, so it survives for free. The mod never invalidates `prompt.context` itself, because that would spend the prompt cache.

**Edge case: the running turn refuses the row.** The answer stays saved and goes as a message the moment the turn ends (toast: "Claude gets #5 as soon as this turn ends"). The test kit has no conversation to append to, so this fallback is what the tests exercise; the append itself needs a live session.

**Edge case: Send now while Claude writes its final reply.** The appended row is already in the conversation, but no step follows to act on it. At `turn.complete`, if a send-now row landed after the turn's last tool call, the mod submits a one-line prompt so Claude acts on it: "Task #5 was answered while you were finishing; the answer is above."

## Tools Claude gets

All three are registered in `session.start`, so they are listed from turn one, and served by `tool.call` hooks. A `tool.describe` hook returns `isDeferred: false` for `assign_task`, so its full description stays in the prompt instead of behind ToolSearch. Plugin tools are named like MCP tools, and MCP tools are deferred by default. The description is the main thing that makes Claude use the tool instead of prose, so it has to be visible.

### `mcp__human-in-the-loop__assign_task`

```jsonc
{
  "title": "Add STRIPE_SECRET_KEY to .env",          // imperative, ≤ 80 chars
  "why": "The webhook test can't run without it.",    // one sentence
  "done_when": "It's in .env. Don't paste it here.",  // optional
  "kind": "do" | "answer" | "choose",
  "options": ["Cursor", "Offset, capped at 10k"]      // choose only, 2–4
}
```

Returns `{ id: 4, open: 3 }`.

Description (what the model reads):

> Give the user a task that only they can do, and keep it in front of them until they act on it. Use it for a secret or credential they must put in place, an action on their machine or on an account you cannot reach (a dashboard, a device, a deploy approval), a decision that is theirs to make, or a review or approval of your work. Assign it even when you also ask in your reply: the user may be busy with other things, and the task keeps the ask in front of them. A task does not block: you keep working while it waits, and the response reaches you whenever the user gets to it, so it suits anything you need from them at some point in the session. AskUserQuestion is the blocking kind: it waits for the answer, so it suits what you need before you can go on. One task per need: list_tasks shows what is already open. Write the title as an imperative the user can act on without scrolling back. For a secret, ask the user to put it where it belongs and mark the task done, rather than paste it. The user sees open tasks in their My tasks pane, or opens it with /my-tasks. The user rejects (with a reason) or fulfills it (done, an option, or an answer in their words). Their response reaches you as a message, or when you call list_tasks.

### `mcp__human-in-the-loop__list_tasks`

`{ "show": "updates" | "open" | "all" }`, default `updates` plus `open`. The result lists each task with its state, answer or reason, and age, and marks the updates it lists as delivered.

> List the tasks you gave the user and what they did with them: done (with their answer or choice), rejected (with their reason). Call it when you're about to need a task's result, or when told updates are waiting.

### `mcp__human-in-the-loop__withdraw_task`

`{ "id": 4, "reason": "Found a fixture in tests/fixtures" }`.

> Take back a task you gave the user when you no longer need it: you found another way, or the plan changed. The user sees the reason.

To change a task, Claude withdraws it and assigns a new one. There is no edit tool in v1.

## What Claude reads

**Send now, idle** (`$.prompt.submit` with `asUser`: the user's own words, so the engine adds no "a plugin sent a message" frame around it):

```
My response to a task you gave me (Human in the loop):

#5 Run xcodebuild test on your Mac, paste the failures:
LoginTests.testExpiredToken
CartTests.testCouponRounding
```

**Send now, mid-turn** (`$.session.append`, a user row): the same text, plus a `system` notice row in the transcript for the user, "Sent your response to #5 to Claude", which the model doesn't read twice.

**Next-prompt digest** (`context` on the user's prompt):

```
Task updates (human-in-the-loop) since you last checked:
#6 done, option chosen: Cursor
#3 rejected: Approve the staging migration. Reason: "staging is frozen until Monday"
#5 done, answer saved (2.1 KB): call list_tasks to read it
```

## The UI

The tasks never touch the band above the prompt, which What's Agent Doing and Anthropic's own "You should know" draw in. The band is one site, so a mod there can hide the mods beneath it: "You should know" does while it shows a card, and so did What's Agent Doing before 0.4.2. Human in the loop uses two surfaces of its own instead.

### The status line

`$.ui.status` pins one line under the prompt for each plugin, so no other mod can cover it. It is there whenever anything is waiting, and gone otherwise:

```
☐ 2 tasks for you · 1 not sent yet · /my-tasks
```

### The My tasks pane

A pane (`$.ui.open({ id: 'tasks', rows })`, drawn by `ui.render` on `Pane`). In Claude Code's fullscreen layout from 110 columns it docks beside the transcript as a sidebar. On the main screen it sits inline above the prompt, sized to what it holds.

- **It opens by itself** when Claude assigns a task, and at a session's start when tasks from an earlier one are waiting. Opened unasked, a pane is seated only from 144 columns (110 once the user has opened it before). Where it can't be seated, a toast says "Claude assigned you: … · /my-tasks".
- **`/my-tasks` opens it** with the keyboard (`focus`), at any width, because the user asked.
- **Hide** closes it; the status line keeps the count. It closes itself once nothing is left in it.

```
╭─ My tasks ──────────────────────────────────────────────────────────╮
│ ☐ 3 tasks for you · 1 not sent yet                                  │
│                                                                     │
│ ☐ #4 Add STRIPE_SECRET_KEY to .env                          4m      │
│      The webhook test can't run without it.                         │
│      Done when: it's in .env (don't paste it here).                 │
│      d: Done   r: Answer…   x: Reject…                              │
│ ☐ #5 Run xcodebuild test on your Mac, paste the failures   12m      │
│ ☐ #6 Pick a pagination strategy for /feed                   1m      │
│ ✓ #3 Approve the staging migration · not sent yet   s: Send now     │
│                                                                     │
│ Esc: back to the prompt   Hide                                      │
╰─────────────────────────────────────────────────────────────────────╯
```

- **The selected task gets the action row.** The oldest open task starts selected, and pressing a title selects that task. Hotkeys are one letter per site, so they act on the selected task only, and they work only while the pane holds the keyboard (`/my-tasks`, a click, or `ctrl+x tab`). Typing a prompt never trips them.
- **Glyphs:** ☐ open, ✓ done with an update not yet delivered, ✗ rejected and not yet delivered. A task leaves once Claude has its update; a withdrawn task leaves at once with a toast: "Claude withdrew the task: …", with Claude's reason.
- **Undelivered rows carry their own button:** `s: Send now`.
- **Choose tasks** list their options as digit buttons: `1: Cursor   2: Offset, capped at 10k   r: Other…   x: Reject…`.
- **The mobile app** draws no text field yet, so there the pane offers Done, the options and a plain Reject.

### Answering

`r: Answer…` turns the selected task's buttons into a one-line `Input` in the pane, with the focus moved into it (`$.ui.focus`). Enter does the default for Claude's state; the button beside it does the other one.

Claude idle:

```
│ ☐ #5 Run xcodebuild test on your Mac, paste the failures   3m   │
│   I can't run Xcode here.                                       │
│   Answer › LoginTests.testExpiredToken, CartTests.testCou▏ send │
│   Save for later   Long answer…   Cancel                        │
```

Claude working: Enter saves (`save`), and the button beside it reads **Send now**.

### Long answers: the composer bridge

`Input` is one line, and the API has no multi-line field. For a pasted log or a reasoned answer, **Long answer…** puts `↳ Answer to #5: ` at the start of the user's own prompt box (`$.prompt.fill`), keeping any draft already there. The user then writes in the real editor, with multi-line text, pastes, images and `@file`:

```
╭─────────────────────────────────────────────╮
│ ↳ Answer to #5: LoginTests.testExpiredToken │
│   CartTests.testCouponRounding              │
│   (pasted 214 lines of xcodebuild output)   │
╰─────────────────────────────────────────────╯
```

A `prompt.submit` hook recognizes the prefix on Enter, strips it, and records the answer:

- **Claude idle:** the prompt goes through as the message, with the task header added. That is Send now.
- **Claude working:** the hook answers `{ drop: "Saved as your answer to #5. Claude gets it with your next message, or press Send now in /my-tasks." }`. That is Save for later. The text is kept on the task, so nothing is lost.

This is the design's biggest bet (see the spike). If the terminal `Input` keeps multi-line pastes, the bridge can wait.

### Secrets

An answer that looks like a secret (`sk_live_`, `sk-ant-`, `AKIA…`, `ghp_`, `xox[bp]-`, `-----BEGIN … PRIVATE KEY`, a long high-entropy token) is held:

```
╭─ Answer #4 ───────────────────────────────────────────────────╮
│ Answer › sk_live_51Hx…▏                                       │
│                                                               │
│ This looks like a secret. Claude and the transcript on disk   │
│ would see it. Put it where it belongs and press Done instead. │
│                                                               │
│ [ Edit ]   Send anyway                                        │
╰───────────────────────────────────────────────────────────────╯
```

### The transcript

- **Assigning a task:** a `ui.render` hook on `ToolUse` draws an `assign_task` call as one line, "☐ Assigned you #4: Add STRIPE_SECRET_KEY to .env", instead of a JSON blob.
- **Resolving a task:** a `system` notice row (`$.session.append`, which the model never reads), such as "✓ You answered #5 · sent to Claude" or "✓ You answered #5 · not sent yet".

## Persistence

- **`$.state` (the session's):** the task list, the selected task, the open field and whether Claude is working. The pane draws from it, and it survives hot reloads.
- **`$.store` (across sessions, one JSON file per plugin):** the key `tasks:<project root>` (`$.session.root()`, the folder the session started in) holds `{ nextId, sessions }`: the next task number, shared by the project's sessions, and one slot per session with its open tasks and undelivered updates, when it was last alive (`seenMs`), and when it ended (`endedMs`). Each session writes its own slot only (`hooks/project.ts`), so sessions never write over each other's tasks.
- **Tasks belong to the session that assigned them.** Its pane shows them, and answers go to its Claude. Another live session in the same project shows none of them; its status line counts them: `1 task in another session`.
- **A session is alive** while it writes its slot: at every change, and on a heartbeat every minute. At `session.end` it marks its slot ended.
- **A new session takes on** the tasks of every session that ended, or went quiet for 3 minutes (a crash, a kill): they show "from an earlier session", that session's Claude learns of them from the `prompt.context` block, and their slots leave the store. A resumed session takes its own slot back.
- **After `/clear`** the process goes on as a new session with no `session.start`: at `session.end` with reason `clear`, the mod joins the project again, taking on the tasks it had.
- **Task numbers** count per project, read fresh from the store at each assignment, so "#5" means one task in conversation, in every session.
- **Not in v1:** expiry (the user rejects stale tasks), cross-project tasks, and moving a task between two live sessions.

## Guardrails

| Risk | Guard |
|---|---|
| Task spam | At most 5 open tasks. The sixth is refused: "Resolve or withdraw one first." The description says one task per need. |
| Asking for what Claude can do | The description scopes tasks to what only the user can do. |
| Duplicates | A title equal to an open task's (after normalizing) returns the existing id instead of a new one. |
| Claude reminding too much | Claude is told the user sees open tasks in the pane and under `/my-tasks`; it may still remind them of one it is blocked on. |
| Compaction or resume | Tasks live in the plugin, not the transcript. `prompt.context` lists them again after a re-read. |
| Subagents | v1 refuses `assign_task` from a subagent (`e.agentId` set): "Report what you need in your result; the main agent assigns tasks." The main loop decides what reaches the user. |
| Secrets | The description asks Claude to have secrets put where they belong rather than pasted, and the secret guard holds answers that look like one. The README says plainly that answers reach the model and the transcript on disk. |
| A turn derailed by an answer | Save for later is the default while Claude works, and a mid-turn Send now is an explicit choice. |
| Send now behind a queued prompt | `$.prompt.submit` waits behind prompts already queued; the row says "queued" until its turn starts. |

## Decisions

- **`/my-tasks`, not `/tasks`.** Claude Code's own `/tasks` lists background tasks, and `/todos` is taken too.
- **Responses arrive as the user's own words.** They are the user's, and the plugin's frame read oddly in the transcript ("This is how Claude Code surfaces a prompt a plugin submits…").
- **Steering by the system prompt, not a second model.** Three lines appended to the system prompt (`prompt.compose`, `scope: 'session'`, after the cache boundary) tell Claude to assign what only the user can do; that a request to review or approve its work is a task too, even when the reply also asks (the user is often busy and lets the reply's question go by, and the task keeps it); and that the user sees open tasks in the pane or with `/my-tasks`. They say what to do, not what not to: a prohibition ("don't ask in your reply", "don't repeat it") could steer Claude too far, and when it genuinely needs a response it may keep asking. Whether that is enough is for beta testing to show. No side model scanning replies for forgotten asks: tool calls are the mechanism.
- **A task is the asynchronous ask; AskUserQuestion is the synchronous one.** The description says so: a task doesn't block, so it suits anything Claude needs at some point in the session; AskUserQuestion waits for the answer, so it suits what Claude needs before it can go on.
- **Tasks belong to the session that assigned them.** With two sessions open in one project, an answer given in the other session's pane would reach the wrong Claude. Each session shows and answers only its own; tasks carry over only from a session that ended or went quiet.
- **No Accept.** A task is open until the user acts on it; "I'll do it" told Claude nothing it could use.
- **A pane and a status line, not the band.** They set the mod apart from the band mods, and no other mod can hide them.
- **Save for later stays.** Fable's revised v1 delivered every update immediately, because mid-turn delivery works. The user decides whether to interrupt: Send now is one press away, and it is not the default while Claude works.
- **No blocking "ask and wait" tool.** A hook has a 10-second budget, and `$.clock.sleep` counts against it. AskUserQuestion already covers "I can't go on without this".
- **The name is `human-in-the-loop`, never abbreviated.** Tools are `mcp__human-in-the-loop__*`.

## Spike first

**Confirmed live (2026-10-03, Claude Code 2.1.288):** the tools are offered to Claude and steer it; a choice sent while Claude is idle starts its next turn; a response delivered while Claude works joins the running turn as a message (item 3); an answer saved while Claude works reaches it through `list_tasks`; the inline answer field works; the pane looks right on the user's terminal.

**Desktop (2026-10-03, Code tab, 2.1.286, hot-loaded mid-session):** a choice, an answer and a Done sent while Claude was idle each started a turn of its own. Item 1: the answer field flattens a multi-line paste. All of it arrives, but each line break becomes a space (the mod only trims), so the composer bridge is needed here. Item 5: opened by `assign_task` mid-turn, the pane was seated and looked right. Item 6: with three tasks open, selecting another one and marking it done from `/my-tasks` works; Tab between the buttons is unchecked. Item 4: all three tools arrived deferred, behind ToolSearch, despite `isDeferred: false`. That may be because the mod loaded mid-session; check again in a session that starts with it.

About two hours in the dev-mods folder before building. Each item can change the design:

1. **Input and a multi-line paste.** Does the terminal `Input` keep it, flatten it, or submit on the first newline? If it keeps it, the composer bridge can wait.
2. **`{ drop }` while a turn runs.** How the reason is shown, and whether the composer is cleared.
3. **`$.session.append` mid-turn.** Claude acts on the row at its next step, and the user sees only our `system` notice.
4. **Plugin tools and ToolSearch.** Plugin tools are deferred like MCP tools, and `tool.describe` with `isDeferred: false` keeps `assign_task` in the prompt.
5. **Seating the pane.** Whether a pane opened while a turn runs counts as asked (the docs count "the person's command, prompt or press" behind it), and how it looks inline on the main screen.
6. **Hotkeys.** With several tasks, the selected-task hotkeys and Tab between the buttons.
7. **Steering.** Does the description alone make Claude assign tasks instead of writing them in prose? Try five real asks. If not, add a two-line `prompt.compose` section (`scope: 'session'`, appended last).

## Build plan

```
human-in-the-loop/
  .claude-plugin/plugin.json   name, version, description, "types": "./types/index.d.ts"
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           tools, delivery, the pane and status line, /my-tasks, inline answers, composer bridge, transcript rows
  hooks/tasks.ts               what Claude is told, the status line, the long-answer prefix, secret shapes
  hooks/project.ts             each session's slot of the project's store, taking on ended sessions' tasks
  hooks/text.ts                printable labels, ages, sizes
  types/index.d.ts             $.state contract
  tests/*.test.tsx
```

```ts
type Task = {
  id: number                       // per project: #1, #2, …
  title: string; why: string; doneWhen?: string
  kind: 'do' | 'answer' | 'choose'; options?: readonly string[]
  state: 'open' | 'done' | 'rejected' | 'withdrawn'
  answer?: string                  // done: the answer or the chosen option
  reason?: string                  // rejected or withdrawn
  update: 'none' | 'pending' | 'delivered'
  createdMs: number; updatedMs: number
  fromEarlierSession?: true
}
interface PluginState {
  'human-in-the-loop': { tasks: readonly Task[]; selectedId: number | null; isExpanded: boolean }
}
```

1. **M1, the loop:** `assign_task` and `withdraw_task`, the pane and status line with Done, Reject and options, and idle Send now. Tests for each transition.
2. **M2, answers:** inline answers, Save for later, the next-prompt digest, `list_tasks`, mid-turn Send now, the final-reply wake-up and the secret guard.
3. **M3, the long tail:** the composer bridge, `$.store` carry-over, `prompt.context` after compaction, and the `ToolUse` row.
4. **M4, ship:** What's Agent Doing 0.4.2 (composing the band), the README (with a demo that isn't meta), validation with `claude plugin validate --strict .claude-plugin/plugin.json`, and a marketplace listing.

## Later

- **Copy the command.** A `do` task with a command gets `c: Copy` (`$.ui.copy`).
- **Answer with a file.** The answer is a path in place of the text, so huge logs and semi-sensitive output stay out of the transcript.
- **Nudge when away.** An OS notification or a Slack DM when a task has blocked work for 10 minutes and the user has gone quiet.
- **Checklists.** One task with sub-steps, such as a run-book, where Claude sees partial progress.
- **Teammates.** "For Dana" lands in Dana's My tasks pane via `$.session.send`.

## Open questions

- **Where a background agent's ask comes from.** Should Done on a task assigned by the main loop for a background agent's need wake that agent (`$.session.send({ to: { agentId } })`) instead of the main loop?
