# Human in the loop: design

A Claude Code mod in which Claude assigns tasks to its user. Each task waits in the My tasks pane, counted in a status line under the prompt, until the user fulfills it or rejects it.

Status: v0.1.0 built, at `~/.claude/dev-mods/<session>/human-in-the-loop/` (16 tests pass, strict validation passes), checked against the mod API of Claude Code 2.1.288. Changes since the first draft: the tasks moved from the band above the prompt to a pane plus a status line ([The UI](#the-ui)); Accept is gone; a mid-turn Send now that the running turn refuses goes as a message the moment the turn ends; since 0.1.3, answers saved while Claude worked go when its turn ends too, once no task is left open (with one open, they go with its answer); since 0.1.4, a response whose prompt doesn't enter stays saved, a session back from sleep lets go of the tasks another session took on, and a task number two sessions drew at once is renumbered where their tasks meet ([Persistence](#persistence)); since 0.1.5, each session's slot has a store key of its own that only it writes, so two sessions in one folder can't write over each other's tasks, a session notes the tasks it takes on in its own slot, in the same write, and answers riding a typed prompt that a hook beneath drops, or takes them out of, wait for the next one; since 0.1.7, the answer field takes the keys as it opens and wraps a long answer, the pane growing to hold it, each task keeps its own draft, a press or a withdraw changes a task only while it is open, emoji count the cells the terminal draws them in, and the pane asks for one height that fits every surface drawing it inline; since 0.1.8, the README says what the mod puts in the prompts it submits, and that the session facts it reads (its id, its project folder) never go in one; since 0.1.9 (Claude Code 2.1.299), `turn.start` names a subagent's or teammate's loop, so the mod knows Claude works from the main loop's turns alone, and no longer reads the band's `isWorking` through a render hook that draws nothing; since 0.1.10 (Claude Code 2.1.301), the answer field is four rows tall in the terminal ([The UI](#the-ui)). What only a live session can confirm is listed under [Spike first](#spike-first).

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

A pane (`$.ui.open({ id: 'tasks', rows })`, drawn by `ui.render` on `Pane`). In Claude Code's fullscreen layout from 110 columns it docks beside the transcript as a sidebar. On the main screen it sits inline above the prompt, sized to what it holds as it wraps there. The rows are one number for every surface, so drawn inline on two at once (the terminal and a phone), it asks for the most either takes. A render doesn't say which of two phones drew it, so there it keeps asking for the most either has needed until one comes or goes.

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

`r: Answer…` turns the selected task's buttons into an `Input` four rows tall (`rows`, from Claude Code 2.1.301) in the pane, with the focus moved into it (`autoFocus`, then `$.ui.focus`). The terminal sizes a field by the pane's body, so it spans the body; a field of several rows is a box that tall, where a backslash and Enter start a new line, a longer text scrolls to the cursor, and out of the keys the text is cut to the box, so the pane's height doesn't change as the user types. The reason field is one row, and the pane grows as its text wraps. Each task keeps its own draft, through another task's field and through Hide. Enter does the default for Claude's state; the button beside it does the other one. An answer entered or pressed for a task that closed meanwhile (Claude withdrew it, or it was answered on another surface) isn't saved: a toast says so, and what was typed goes to the prompt box. Pressed for such a task, a title, or a button that opens a field, leaves the pane as it is. A task Claude withdraws takes its open field along, and what was typed in it: put in the prompt box unasked, it would join whatever the user is writing there.

Claude idle:

```
│ ☐ #5 Run xcodebuild test on your Mac, paste the failures   3m   │
│   I can't run Xcode here.                                       │
│ Answer: LoginTests.testExpiredToken, ⏎ send                     │
│         CartTests.testCouponRounding                            │
│   Save for later   Long answer…   Cancel                        │
```

Claude working: Enter saves (`save`), and the button beside it reads **Send now**.

### Long answers: the composer bridge

The answer field holds four lines in the terminal. The desktop app draws it as one line until its support for `rows` lands, and turns a pasted log's line breaks into spaces. So for desktop, and for a log longer than the field, **Long answer…** puts `↳ Answer to #5: ` at the start of the user's own prompt box (`$.prompt.fill`), keeping any draft already there. The user then writes in the real editor, with multi-line text, pastes, images and `@file`:

```
╭─────────────────────────────────────────────╮
│ ↳ Answer to #5: LoginTests.testExpiredToken │
│   CartTests.testCouponRounding              │
│   (pasted 214 lines of xcodebuild output)   │
╰─────────────────────────────────────────────╯
```

A `prompt.submit` hook recognizes the prefix on Enter, strips it, and records the answer:

- **Claude idle:** the prompt goes through as the message, with the task header added. That is Send now.
- **Claude working:** the hook answers `{ drop: "Saved as your answer to #5. Claude gets it when this turn ends, or press Send now in /my-tasks." }` ("with your other answers" while another task is open). That is Save for later. The text is kept on the task, so nothing is lost.
- **The task closed meanwhile** (Claude withdrew it, or it was answered on another surface): the prompt goes through as typed, prefix and all. No toast is needed, since the text still reaches Claude.

This was the design's biggest bet (see the spike), made while `Input` was one line.

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

- **`$.state` (the session's):** the task list, the selected task, the open field, whether Claude is working and the remote clients attached. The pane draws from it, and it survives hot reloads.
- **`$.store` (across sessions, one JSON file per plugin):** each session's slot sits under a key of its own, `tasks:<project root>#session:<id>` (`$.session.root()`, the folder the session started in; a root too long for the store's keys, 256 UTF-16 code units, goes by its hash), and only that session writes it: its open tasks and undelivered updates, when it was last alive (`seenMs`), when it ended (`endedMs`), the next task number as it counts them (`nextId`), and the tasks it took on from other sessions (`took`). `$.store` writes one key at a time and has no compare-and-set, so a key per session is what keeps one session from putting back a stale copy of another's tasks (`hooks/project.ts`). A session id has no `#`, so a key that goes on with one past the prefix is another folder's, whose path goes on with `#session:`. Anything stored that isn't a slot is skipped, and so is anything in a slot that isn't a task, a count or a note. 0.1.4 kept the whole project in one value under `tasks:<project root>`: this version reads it (skipping any entry in it that isn't a slot or a note), takes on its sessions' tasks like any others, and changes it only to take their slots out, leave a note for a quiet one, and, while a 0.1.4 session is alive there, raise the task count it numbers from when it falls behind; each change is made to the value read fresh just before, once the session's own slot carries what it relies on (a note of 0.1.4's leaves once the tasks it named are let go in the slot).
- **Tasks belong to the session that assigned them.** Its pane shows them, and answers go to its Claude. Another live session in the same project shows none of them; its status line counts them: `1 task in another session`.
- **A session is alive** while it writes its slot: at every change, and on a heartbeat every minute; one that never held a task writes none. At `session.end` it marks its slot ended in one write, reading nothing (one that never read the project reads it first): the exit's budget is short, and the end waits for the write through half of what is left of it at most. A slot not marked in time goes stale, and is taken on 3 minutes later.
- **A new session takes on** the tasks of every session that ended, or went quiet for 3 minutes (a crash, a kill): they show "from an earlier session", and that session's Claude learns of them from the `prompt.context` block. Its own slot notes what it took, in the same write that holds the tasks; only then does an ended session's slot leave the store, and an empty one's, unless it changed since it was read. A crash in between leaves no task to take on twice: the note says it's taken. Until that write lands (a store that fails just then), a session it took from that comes back keeps the tasks too, and lets them go once it reads the note. A slot that leaves takes with it any copy of it in 0.1.4's value, where a 0.1.4 session's write can put back the copy from before its session came to this version. A resumed session takes its own slot back.
- **A quiet session that comes back** (a laptop asleep longer than 3 minutes) finds the note in the slot of the session that took its tasks on, at its next heartbeat, or before a press, a prompt or a call of its tools acts on its tasks once it has neither written its slot nor read the project for two heartbeats: it lets those tasks go instead of writing them back, so one task never waits in two panes, and a toast tells the user to answer them in the other session. Its slot stays until it comes back, or for 30 days: then the session that took its tasks removes it, and carries on the slot's own notes of what it took, so none of those is taken on twice. A note goes once the tasks are let go, or once their slot is gone. A session that takes its own tasks back from one that had taken them (resumed after it ended, say, while that one is quiet) keeps them: its note is the later, and outweighs the other's (the note as the session holds it, before the store has it too), which that session drops when it comes back and lets them go.
- **Reads and writes:** joining, the heartbeat and assigning read the project, one read per key; a press or a prompt, which a person waits on, writes the session's own slot and reads nothing, but for the sleep check above. The session's state is what counts: a write that fails, the next one makes, the count in it too, though the tasks are gone by then. A store slow to answer holds up a press, a prompt, a tool call or the session's start 5 seconds at most for each piece of store work it waits on (the sleep check's read, then its write): the store work finishes on its own, in its turn, and until it does nothing else waits on the store, and the heartbeat asks it for nothing more. Opening the pane is no store work: a surface slow to open it holds up the start or a heartbeat 5 seconds at most, and the store goes on being asked as before.
- **After `/clear` or a resume in place** the process goes on as another session with no `session.start`: at `session.end` with reason `clear` or `resume`, the mod joins the project again as that session, taking on the tasks it had as it holds them: the end write may have failed. It joins once the store work in flight is done; until then (a store slow to answer), a task Claude assigns is the new session's all the same, and a session that ends first ends as any other: it takes nothing quiet, and its slot is marked ended. Resumed into another folder, it starts there as a new session would, and until it has read that folder (the last, when it is resumed again first) it acts on no task it holds: Claude can't assign, list or withdraw a task, no response goes to Claude, and no prompt carries one. Then it holds none of this folder's tasks, which wait in this folder's store as its last write there left them, nor an answer typed to one, and numbers from that folder's count.
- **A session that can't read the project as it joins** (a store that fails just then) writes nothing until it has, 0.1.4's value included: the store may hold tasks of its own it hasn't taken on, a resumed session's, that a write would go over. The heartbeat, assigning and its end read the project again; it then takes on what the store holds for it, with what it held meanwhile: the tasks of the session it left (which its state names, so a hot reload keeps it), or, when no session of the process has read the project, those its sessions assigned, numbered without the project's count. Each of those sessions has ended unless the store says otherwise: alive or quiet there, another process has resumed it since, or may have, and it keeps its slot, while what it assigned here goes on in this session's. Read only as it ends, the session takes nothing from a quiet session, which may come back: the next session to start takes that on. Read later, the project shows as at joining, though the write that follows fails: the pane opens for what was taken on. A session takes the project on against its task list as it stands at that moment, so a press meanwhile is kept; its own tasks it is done with stay in it, and no task it takes on gets one of their numbers.
- **Task numbers** count per project, read fresh from the store at each assignment: each slot carries its session's count, and a slot leaves the store only once a later one carries it, so the next number is past every number the project's sessions drew. `$.store` has no compare-and-set, so it can't reserve a number: two sessions assigning at the same moment can draw the same one. That's harmless while they're apart, since each shows and answers only its own tasks. Where their tasks meet (one session taking on another's), the session's own tasks keep their numbers, the ones its Claude knows, then those the process holds after /clear or a resume in place, the ones the user knows, and a duplicate gets the next free number, as does a task taken on whose number a 0.1.4 note names as taken from the session: a 0.1.4 session's write can put that note back after it was read. What the pane keeps under a number follows the task: one the process held takes its drafts, its open field and the selection to its new number, and a task taken on under a number the process used takes no draft or field kept there.
- **A response that doesn't reach Claude stays saved.** It is claimed (marked delivered, in one change of the task list) before its prompt or its row goes, the mod's own or a typed prompt it rides, so no other path sends it twice; a prompt that doesn't enter with it (a hook drops the prompt or takes the response out, or the call fails) puts it back as not sent yet, for Send now or the next prompt, and so does a row the running turn refuses, to go when the turn ends. A toast says so, but for a prompt of the user's own that it rode and a hook dropped: the engine shows why, and the response waits as it did. A hook beneath that only rewrites a response (masks a secret in it, say) still delivers it: its head entered, `#5 <title>:` in a message's words, `#5 done: <title>.` in the digest beside a typed prompt's; one that takes some responses out gives back those alone, and one that rewords a head gives that response back, since Claude hearing it twice beats not hearing it. One given back by a prompt that entered goes with Send now, the next prompt or another response as it goes, but sends nothing by itself as a turn ends: the turn that prompt started would end with it waiting, and send it again, over and over. An answer typed in the prompt box while Claude is idle carries every response not sent yet, those a batch of presses was about to send among them; when another send took it as it was saved, the prompt is dropped, saying it went.
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
