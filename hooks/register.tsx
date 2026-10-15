import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolSpec } from 'claude-code'

import type { Editing, Task } from '../types'
import {
  MAX_OPEN,
  MAX_TITLE,
  answerIn,
  assignedOf,
  bridgeOf,
  contextOf,
  digestOf,
  isActive,
  isShown,
  listOf,
  looksSecret,
  messageOf,
  parseAsk,
  sameAsk,
  statusOf,
} from './tasks'
import {
  ANSWER_LABEL,
  BUTTON_GAP,
  HELD,
  HIDE,
  MAX_SHOWN_TITLE,
  REASON_LABEL,
  REASON_PLACEHOLDER,
  actionsOf as actionsFor,
  ageOf,
  answerButtonsOf,
  answerPlaceholderOf,
  doneWhenOf,
  headlineOf,
  hintOf,
  nameOf,
  rowsFor,
  savedOf,
  selectedOf,
  titleOf,
  whyOf,
} from './pane'
import type { PaneView } from './pane'
import { HEARTBEAT_MS, adopt, elsewhereIn, endSlot, isLegacy, keysOf, storedFrom, storedOf, takenFrom, withSlot, writesOf } from './project'
import type { Stored } from './project'
import { oneLine, printable } from './text'

const PLUGIN = 'human-in-the-loop'

const ASSIGN = 'mcp__human-in-the-loop__assign_task'
const LIST = 'mcp__human-in-the-loop__list_tasks'
const WITHDRAW = 'mcp__human-in-the-loop__withdraw_task'

/**
 * Three lines at the end of the system prompt: where an ask for the user goes
 * so it stays in front of them, that a review is one even when the reply asks
 * for it too (the user is often busy and lets the reply's question go by),
 * and where they see it. Said as what to do,
 * never what not to: nothing here stops Claude reminding the user of a task.
 */
const STEERING = [
  "When you need something only the user can do (a secret put in place, an action on their machine or an account you can't reach, a decision that's theirs), assign it with mcp__human-in-the-loop__assign_task so it stays in front of them until they act on it.",
  'That includes asking the user to review or approve your work: assign it as a task even when you also ask in your reply, since they may be busy with other things when you ask, and the task keeps it in front of them.',
  'The user sees open tasks in their My tasks pane, or opens it with /my-tasks, and their response reaches you as a message.',
].join('\n')

/** Resolutions pressed this close together go to Claude as one message. */
const BATCH_MS = 800

/** The pane the tasks wait in, and the command that opens it. */
const PANE = 'my-tasks'
const PANE_TITLE = 'My tasks'
const MAX_PANE_ROWS = 18

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'assign_task',
    description: [
      'Give the user a task that only they can do, and keep it in front of them until they act on it.',
      'Use it for a secret or credential they must put in place, an action on their machine or on an account you cannot reach (a dashboard, a device, a deploy approval), a decision that is theirs to make, or a review or approval of your work.',
      'Assign it even when you also ask in your reply: the user may be busy with other things, and the task keeps the ask in front of them.',
      'A task does not block: you keep working while it waits, and the response reaches you whenever the user gets to it, so it suits anything you need from them at some point in the session.',
      'AskUserQuestion is the blocking kind: it waits for the answer, so it suits what you need before you can go on.',
      'One task per need: list_tasks shows what is already open.',
      'Write the title as an imperative the user can act on without scrolling back.',
      'For a secret, ask the user to put it where it belongs and mark the task done, rather than paste it.',
      'The user sees open tasks in their My tasks pane, or opens it with /my-tasks.',
      'The user rejects (with a reason) or fulfills it (done, an option, or an answer in their words). Their response reaches you as a message, or when you call list_tasks.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'What the user should do, as an imperative they can act on without scrolling back. Under 80 characters.',
        },
        why: {
          type: 'string',
          description: 'One sentence: what it unblocks, or why only the user can do it.',
        },
        done_when: {
          type: 'string',
          description: "Optional: what counts as done. For a secret: \"It is in .env. Don't paste it here.\"",
        },
        kind: {
          type: 'string',
          enum: ['do', 'answer', 'choose'],
          description: 'do: the user does something and marks it done. answer: you need their words (an error, a log, test results). choose: they pick one of options.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'For choose only: 2 to 4 short options.',
        },
      },
      required: ['title', 'why', 'kind'],
    },
  },
  {
    name: 'list_tasks',
    description: [
      'List the tasks you gave the user and what they did with them: accepted, done (with their answer or choice), rejected (with their reason).',
      'Call it when you are about to need a task\'s result, when told an answer is saved for you, or before assigning, to avoid a duplicate.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['updates', 'open', 'all'],
          description: 'updates (the default): open tasks and responses you have not seen. open: open tasks only. all: every task this session.',
        },
        id: { type: 'number', description: 'One task, whole, by its number.' },
      },
    },
  },
  {
    name: 'withdraw_task',
    description: 'Take back a task you gave the user when you no longer need it: you found another way, or the plan changed. The user sees the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task\'s number.' },
        reason: { type: 'string', description: 'One short sentence the user sees.' },
      },
      required: ['id'],
    },
  },
]

const tasks = atom({ plugin: 'human-in-the-loop', key: 'tasks' } as const, [] as readonly Task[])
const nextId = atom({ plugin: 'human-in-the-loop', key: 'nextId' } as const, 1)
const selectedId = atom({ plugin: 'human-in-the-loop', key: 'selectedId' } as const, null as number | null)
const editing = atom({ plugin: 'human-in-the-loop', key: 'editing' } as const, null as Editing | null)
const loadedFor = atom({ plugin: 'human-in-the-loop', key: 'loadedFor' } as const, null as string | null)
const isWorking = atom({ plugin: 'human-in-the-loop', key: 'isWorking' } as const, false)

/**
 * Send now goes to Claude as a message (`auto` while it is idle), Save for
 * later waits (`auto` while it works) until its turn ends with every task
 * answered, a later answer while it is idle, or the user's next prompt.
 */
type How = 'auto' | 'now' | 'later'

/** What the module tracks beside `$.state`; a hot reload starts it over. */
const live = {
  sessionId: '',
  root: '',
  /** A Send now row joined the running turn and no step has read it yet. */
  isUnread: false,
  /** A Send now the running turn could not take: it goes once the turn ends. */
  isSendingAtEnd: false,
  /** What the user has typed in an answer field so far, by task. */
  drafts: new Map<number, string>(),
  batch: null as Timer | null,
  /** Says in the project's store that this session is alive. */
  heartbeat: null as Timer | null,
  /** Tasks waiting in the project's other live sessions. */
  elsewhere: 0,
  /**
   * Turns begun and not yet ended. `turn.start` names no loop, so a loop
   * other than main's (an engine side request, a teammate) may begin one that
   * ends under an agent id: each ends by its own id.
   */
  turns: new Set<string>(),
  /** Whether a turn runs, in the engine's own word (the band's `isWorking`), once it has said. */
  engineWorking: undefined as boolean | undefined,
  /**
   * The pane's body as last drawn: its width, whether it draws a field and
   * holds the keys; until it is first drawn, an 80-column terminal's.
   */
  columns: 76,
  canType: true,
  isFocused: false,
  /** The rows the pane last asked for. */
  rows: 0,
}

/** Whether Claude is at work: the engine's word when it has given one, else the turns begun and not ended. */
function working(): boolean {
  return live.engineWorking ?? live.turns.size > 0
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }

    await $.command.register({ name: 'my-tasks', description: 'Show the tasks Claude gave you' })
    await join($)

    return next(e)
  })

  // An ended session's tasks wait in the store for the next session in the
  // project. After /clear the process goes on as a new session with no
  // session.start, so it joins the project again here.
  on('session.end', async ($, e, next) => {
    live.heartbeat?.cancel()
    live.heartbeat = null

    try {
      const stored = await readStore($)
      await writeStore($, stored, endSlot(stored, e.sessionId, await $.clock.now()))
    } catch {
      // A store that can't be written in the exit's short budget leaves the
      // slot to go stale, and the next session takes it on then.
    }

    const ended = await next(e)

    if (e.reason === 'clear') {
      $.clock.after(0, () => void join($))
    }

    return ended
  })

  on('command.run', { command: 'my-tasks' }, async $ => {
    if ((await read($, tasks)).filter(isShown).length === 0) {
      return { text: 'No tasks for you right now.' }
    }

    await show($, true)

    return {}
  })

  // The tools stay in the prompt's list, descriptions and all, where an MCP
  // tool would wait behind ToolSearch: the description is what steers Claude
  // to assign a task, so the ask stays in front of the user.
  on('tool.describe', { tool: 'mcp__human-in-the-loop__assign_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__human-in-the-loop__list_tasks' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__human-in-the-loop__withdraw_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: ASSIGN }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent assigns tasks to the user. Say what you need from the user in your result instead.' }
    }

    const ask = parseAsk(e as unknown as Record<string, unknown>)

    if ('error' in ask) {
      return { deny: ask.error }
    }

    const active = (await read($, tasks)).filter(isActive)
    const same = active.find(task => sameAsk(task.title, ask.title))

    if (same !== undefined) {
      return { result: `Task #${same.id} already asks the user for this ("${same.title}"); nothing new was assigned.` }
    }

    if (active.length >= MAX_OPEN) {
      return {
        deny: `The user already has ${MAX_OPEN} open tasks. Withdraw one you no longer need, or wait for them to act (list_tasks shows them).`,
      }
    }

    // Task numbers count per project, across its sessions: the store's count
    // is read fresh. Two sessions assigning at the same moment can still draw
    // one number; each shows and answers only its own, and where their tasks
    // meet (one taking on the other's), `adopt` gives the later a new one.
    const counted = (await readStore($)).nextId
    const id = await read($, nextId).then(n => Math.max(n, counted))
    await update($, nextId, () => id + 1)
    const nowMs = await $.clock.now()
    const task: Task = {
      id,
      ...ask,
      state: 'open',
      update: 'none',
      sessionId: live.sessionId,
      createdMs: nowMs,
      updatedMs: nowMs,
    }

    await change($, list => [...list, task])
    await update($, selectedId, chosen => chosen ?? id)

    if (!(await show($, false))) {
      $.ui.toast(`Claude assigned you a task: ${printable(task.title, MAX_TITLE)}. See /my-tasks`)
    }

    return { result: assignedOf(task, active.length + 1) }
  })

  on('tool.call', { tool: LIST }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const id = typeof args['id'] === 'number' ? args['id'] : undefined
    const scope = args['show'] === 'open' || args['show'] === 'all' ? args['show'] : 'updates'
    const list = await read($, tasks)

    const picked =
      id !== undefined
        ? list.filter(task => task.id === id)
        : scope === 'all'
          ? list
          : scope === 'open'
            ? list.filter(isActive)
            : list.filter(isShown)

    if (id !== undefined && picked.length === 0) {
      return { result: `No task #${id}.` }
    }

    // A subagent's read tells the main agent nothing.
    if (e.agentId === undefined) {
      await delivered($, picked.filter(task => task.update === 'pending').map(task => task.id))
    }

    return { result: listOf(picked, await $.clock.now()) }
  })

  on('tool.call', { tool: WITHDRAW }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent withdraws tasks.' }
    }

    const args = e as unknown as Record<string, unknown>
    const id = args['id']
    const reason = typeof args['reason'] === 'string' ? oneLine(args['reason']) : ''
    const task = (await read($, tasks)).find(one => one.id === id)

    if (task === undefined) {
      return { deny: `No task #${String(id)}.` }
    }

    if (!isActive(task)) {
      return { deny: `Task #${task.id} is already ${task.state}; there is nothing to withdraw.` }
    }

    await edit($, task.id, one => ({
      ...one,
      state: 'withdrawn',
      update: 'delivered',
      ...(reason === '' ? {} : { reason }),
    }))
    await settle($, task.id)
    const why = reason === '' ? '' : `. ${printable(reason, 200)}`
    $.ui.toast(`Claude withdrew the task: ${printable(task.title, MAX_TITLE)}${why}`, { timeoutMs: 8000 })

    return { result: `Withdrew task #${task.id}; it is gone from the user's My tasks pane.` }
  })

  on('turn.start', async ($, e, next) => {
    live.isUnread = false
    live.turns.add(e.turnId)
    await syncWorking($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      live.isUnread = false
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main's turn ending ends every turn; another loop's ends its own.
    if (e.agentId === undefined) {
      live.turns.clear()
      live.engineWorking = false
    } else {
      live.turns.delete(e.turnId)
    }

    await syncWorking($)

    if (e.agentId === undefined) {
      // Answers saved while Claude worked go now that it's free, unless a
      // task is still open: then they go with that last answer, together.
      const all = await read($, tasks)
      const isAllAnswered = all.some(task => task.update === 'pending') && !all.some(isActive)

      if (live.isSendingAtEnd || isAllAnswered) {
        live.isSendingAtEnd = false
        // This message wakes Claude, which reads any row it missed above it.
        live.isUnread = false
        void send($, true)
      } else if (live.isUnread) {
        // A Send now that joined the turn during its final reply sits in the
        // conversation with no step left to read it: wake Claude up for it.
        live.isUnread = false
        void $.prompt.submit({ text: 'I answered a task while you were finishing your reply; my answer is above.', asUser: true })
      }
    }

    return result
  })

  // Draws nothing and passes the band on: it only reads the engine's word on
  // whether a turn runs, which no turn event gives for every loop.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (live.engineWorking !== e.props.isWorking) {
      live.engineWorking = e.props.isWorking
      $.clock.after(0, () => void syncWorking($))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === PLUGIN) {
      return next(e)
    }

    const bridged = answerIn(e.text)
    const task = bridged === null ? undefined : (await read($, tasks)).find(one => one.id === bridged.id && isActive(one))

    if (bridged !== null && task !== undefined) {
      if (looksSecret(bridged.answer)) {
        return {
          drop: `This looks like a secret, so it wasn't sent. Put it where it belongs, then mark #${task.id} Done.`,
        }
      }

      const given = bridged.answer === '' ? {} : { answer: bridged.answer }

      if (e.turnId !== undefined) {
        await resolve($, task.id, { state: 'done', ...given }, 'later')
        const when = (await read($, tasks)).some(isActive) ? 'with your other answers' : 'when this turn ends'

        return {
          drop: `Saved as your answer to #${task.id}. Claude gets it ${when}, or press Send now in /my-tasks.`,
        }
      }

      // Claude is idle: this prompt is the answer, sent with every other
      // update Claude has not heard.
      await resolve($, task.id, { state: 'done', ...given }, 'later')
      const due = (await read($, tasks)).filter(one => one.update === 'pending')

      return passOn($, due, () => next({ ...e, text: messageOf(due) }))
    }

    const due = (await read($, tasks)).filter(one => one.update === 'pending')

    if (due.length === 0) {
      return next(e)
    }

    return passOn($, due, () => next({ ...e, context: [...(e.context ?? []), digestOf(due)] }))
  })

  // Read at a conversation's start and again after a compaction: what is
  // still with the user, so Claude neither forgets nor assigns it twice.
  // Added last, on the session's side of the cache boundary, wherever the
  // tool can be reached: offered outright, or found through ToolSearch.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === ASSIGN || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'human-in-the-loop:tasks', text: STEERING, scope: 'session' }] }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const shown = (await read($, tasks)).filter(isShown)

    if (shown.length === 0) {
      return result
    }

    return { ...result, blocks: [...result.blocks, { name: 'humanInTheLoop', text: contextOf(shown, live.sessionId) }] }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: ASSIGN } }, ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | null | undefined
    const title = typeof input?.['title'] === 'string' ? input['title'] : ''

    if (title === '' || e.props.isErrored || e.props.isInterrupted) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      // One text, so the label keeps its words whole and the title wraps after it.
      <Text wrap="wrap">
        <Text color="yellow">{'☐ '}</Text>
        <Text bold>{'Assigned you a task: '}</Text>
        {printable(title, MAX_SHOWN_TITLE)}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no field yet: answers and reasons wait for a surface that does.
    const Input = 'Input' in elements ? elements.Input : undefined
    const view = await paneView($, { canType: Input !== undefined, isFocused: e.props.isFocused })

    // The pane asks for the rows its tree takes at the width it is drawn in:
    // a long title wraps, and a pane sized for one row would cut off the rest.
    live.columns = e.props.bodyColumns
    live.canType = view.canType
    live.isFocused = view.isFocused

    if (e.props.placement === 'inline' && rowsFor(view, live.columns, MAX_PANE_ROWS) !== live.rows) {
      void fit($)
    }

    const { shown, editing: field, isWorking: working } = view

    if (shown.length === 0) {
      return <Text dimColor>No tasks for you right now.</Text>
    }

    const active = shown.filter(isActive)
    const saved = shown.filter(task => !isActive(task))
    const selected = selectedOf(view)
    const head = headlineOf(view)

    // The glyph keeps its cells beside a title that wraps.
    const glyph = (
      <Box flexShrink={0}>
        <Text color="yellow">{'☐ '}</Text>
      </Box>
    )

    // The title and its age are one text, so a long title wraps under itself
    // and the age follows it, never squeezed into a column of its own.
    const titleText = (task: Task, isBold: boolean) => (
      <Text wrap="wrap">
        <Text bold={isBold}>{titleOf(task)}</Text>
        <Text dimColor>{ageOf(task, view)}</Text>
      </Text>
    )

    const actionsOf = (task: Task) => (
      <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
        {actionsFor(task, view.canType).map(action => (
          <Button
            key={action.key}
            plain
            hotkey={action.hotkey}
            label={action.label}
            onPress={() => {
              if (action.option !== undefined) {
                return resolve($, task.id, { state: 'done', answer: action.option }, 'auto')
              }

              if (action.key === 'done') {
                return resolve($, task.id, { state: 'done' }, 'auto')
              }

              if (action.key === 'answer') {
                return startEditing($, task.id, 'answer')
              }

              return view.canType ? startEditing($, task.id, 'reason') : resolve($, task.id, { state: 'rejected' }, 'auto')
            }}
          />
        ))}
      </Box>
    )

    const answerField = (task: Task, held: string | undefined) => {
      if (Input === undefined) {
        return null
      }

      if (held !== undefined) {
        return (
          <Box key="held" flexDirection="column">
            <Text color="yellow" wrap="wrap">
              {HELD}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
              <Button key="edit" plain label="Edit" onPress={() => update($, editing, (): Editing => ({ id: task.id, field: 'answer' }))} />
              <Button key="send-anyway" plain label="Send anyway" onPress={() => answer($, task.id, held, 'auto', true)} />
            </Box>
          </Box>
        )
      }

      const [otherWay, long, cancel] = answerButtonsOf(view)

      return (
        <Box key="field" flexDirection="column">
          <Input
            key="answer"
            label={ANSWER_LABEL}
            placeholder={answerPlaceholderOf(view)}
            value={live.drafts.get(task.id) ?? ''}
            submitLabel={working ? 'save' : 'send'}
            autoFocus
            onInput={value => {
              live.drafts.set(task.id, value)
            }}
            onSubmit={value => answer($, task.id, value, 'auto')}
          />
          <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
            <Button
              key="other-way"
              plain
              label={otherWay}
              onPress={() => answer($, task.id, live.drafts.get(task.id) ?? '', working ? 'now' : 'later')}
            />
            <Button key="long" plain label={long} onPress={() => longAnswer($, task.id)} />
            <Button key="cancel" plain label={cancel} onPress={() => stopEditing($)} />
          </Box>
        </Box>
      )
    }

    const reasonField = (task: Task) => {
      if (Input === undefined) {
        return null
      }

      return (
        <Box key="field" flexDirection="column">
          <Input
            key="reason"
            label={REASON_LABEL}
            placeholder={REASON_PLACEHOLDER}
            submitLabel="reject"
            autoFocus
            onSubmit={value => {
              const reason = oneLine(value)
              return resolve($, task.id, { state: 'rejected', ...(reason === '' ? {} : { reason }) }, 'auto')
            }}
          />
          <Button key="cancel" plain label="Cancel" onPress={() => stopEditing($)} />
        </Box>
      )
    }

    const selectedRows = (task: Task) => {
      const isEditing = field !== null && field.id === task.id
      const control = !isEditing
        ? actionsOf(task)
        : field.field === 'answer'
          ? answerField(task, field.held)
          : reasonField(task)
      const doneWhen = doneWhenOf(task)

      return (
        <Box key={`task-${task.id}`} flexDirection="column" flexShrink={0}>
          <Box flexDirection="row">
            {glyph}
            {titleText(task, true)}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Text wrap="wrap">{whyOf(task)}</Text>
            {doneWhen === undefined ? null : (
              <Text dimColor wrap="wrap">
                {doneWhen}
              </Text>
            )}
            {control}
          </Box>
        </Box>
      )
    }

    const taskRows = active.map(task =>
      task.id === selected?.id ? (
        selectedRows(task)
      ) : (
        <Box key={`task-${task.id}`} flexDirection="row" flexShrink={0}>
          {glyph}
          <Box flexShrink={0}>
            <Button key={`select-${task.id}`} plain dimColor label={`#${task.id}`} onPress={() => select($, task.id)} />
          </Box>
          <Text dimColor wrap="wrap">
            {` ${nameOf(task)}${ageOf(task, view)}`}
          </Text>
        </Box>
      ),
    )

    const savedRows = saved.map((task, i) => (
      <Box key={`saved-${task.id}`} flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>{task.state === 'rejected' ? <Text color="red">{'✗ '}</Text> : <Text color="green">{'✓ '}</Text>}</Box>
        <Text dimColor wrap="wrap">
          {savedOf(task)}
        </Text>
        <Box flexShrink={0} marginLeft={2}>
          <Button key={`send-${task.id}`} plain {...(i === 0 ? { hotkey: 's' } : {})} label="Send now" onPress={() => sendNow($)} />
        </Box>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" flexShrink={0}>
          <Text wrap="wrap">
            <Text color={active.length > 0 ? 'yellow' : 'gray'}>{head.glyph}</Text>
            <Text bold>{head.headline}</Text>
            <Text dimColor>{head.note}</Text>
          </Text>
        </Box>
        <Box key="tasks" flexDirection="column" marginTop={1} flexShrink={0}>
          {taskRows}
          {savedRows}
        </Box>
        <Box key="foot" flexDirection="row" marginTop={1} columnGap={BUTTON_GAP} flexShrink={0}>
          <Text dimColor wrap="wrap">
            {hintOf(view)}
          </Text>
          <Box flexShrink={0}>
            <Button key="hide" plain dimColor role="dismiss" label={HIDE} onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      </Box>
    )
  })
}

/** Keeps the pane's word on whether Claude works (Enter sends, or saves) in step. */
async function syncWorking($: EngineInterface) {
  const now = working()

  await update($, isWorking, () => now)
}

/**
 * Joins the project as this session: takes on its tasks, the store's slot
 * kept alive by a heartbeat, the status line and, for tasks taken on from an
 * earlier session, the pane.
 */
async function join($: EngineInterface) {
  live.sessionId = await $.session.id()
  live.root = await $.session.root()
  await load($)

  live.heartbeat?.cancel()
  live.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))

  // Tasks from an earlier session: the status line says so, and the pane
  // opens where the terminal is wide enough to seat it unasked.
  if (await refresh($)) {
    await show($, false)
  }
}

/**
 * Takes on the tasks this session owns in the project's store: its own (a
 * resumed session) and those of sessions that ended or went quiet. A live
 * session's tasks stay its own: answers go to the session that asked. A hot
 * reload keeps the session's tasks as they are.
 */
async function load($: EngineInterface) {
  const nowMs = await $.clock.now()

  if ((await read($, loadedFor)) === live.sessionId) {
    await beat($)
    return
  }

  const found = await readStore($)
  const { adopted, stored } = adopt(found, live.sessionId, nowMs)

  await update($, tasks, () => adopted)
  await update($, nextId, n => Math.max(n, stored.nextId))
  await update($, loadedFor, () => live.sessionId)
  await writeStore($, found, withSlot(stored, live.sessionId, adopted, nowMs))

  // A project's key is made as its first session joins, tasks or not, as
  // it was before slots had keys of their own: the live render check finds
  // the store's file by it.
  const project = keysOf(live.root).project
  if (!(await $.store.keys()).includes(project)) {
    await $.store.set(project, { nextId: stored.nextId })
  }
  live.elsewhere = elsewhereIn(stored, live.sessionId, nowMs)
  await reselect($)
}

/** Says this session is alive, and counts the tasks waiting in the project's other sessions. */
async function beat($: EngineInterface) {
  const nowMs = await $.clock.now()
  const found = await readStore($)
  const stored = await letGo($, found)
  const elsewhere = elsewhereIn(stored, live.sessionId, nowMs)

  await writeStore($, found, withSlot(stored, live.sessionId, await read($, tasks), nowMs))

  if (stored !== found || elsewhere !== live.elsewhere) {
    live.elsewhere = elsewhere
    await refresh($)
  }
}

/**
 * Lets go of the tasks another session took on while this one was quiet (a
 * laptop asleep, say): they are that session's now, and the user answers
 * them there. Resolves the store with that note read, or `stored` itself.
 */
async function letGo($: EngineInterface, stored: Stored): Promise<Stored> {
  const { ids, stored: rest } = takenFrom(stored, live.sessionId)

  if (rest === stored) {
    return stored
  }

  const lost = (await read($, tasks)).filter(task => ids.includes(task.id) && isShown(task))

  await update($, tasks, list => list.filter(task => !ids.includes(task.id)))

  for (const task of lost) {
    await settle($, task.id)
  }

  if (lost.length > 0) {
    const which = lost.map(task => `#${task.id}`).join(', ')
    const [noun, them] = lost.length === 1 ? ['task', 'it'] : ['tasks', 'them']

    $.ui.toast(`Another session in this project took on ${noun} ${which} while this one was away. Answer ${them} there.`, {
      timeoutMs: 8000,
    })
  }

  return rest
}

/**
 * Reads the project from the store: its key, and each session's and note's
 * own. A slot or note an older version kept in the project's key moves to a
 * key of its own here, so this version's writes never pass over it.
 */
async function readStore($: EngineInterface): Promise<Stored> {
  const keys = keysOf(live.root)
  const entries: Record<string, unknown> = {}

  for (const key of await $.store.keys()) {
    if (key === keys.project || key.startsWith(keys.sessionPrefix) || key.startsWith(keys.takenPrefix)) {
      entries[key] = await $.store.get(key)
    }
  }

  const stored = storedFrom(live.root, entries)

  if (isLegacy(entries[keys.project])) {
    const { [keys.project]: _, ...own } = entries
    await writeStore($, { ...storedFrom(live.root, own), nextId: 0 }, stored)
  }

  return stored
}

/** Writes what changed from `before`, as read, to `after`: this session's slot, and only what it took on or let go. */
async function writeStore($: EngineInterface, before: Stored, after: Stored) {
  const keys = keysOf(live.root)
  const { set, remove } = writesOf(live.root, before, after)

  for (const [key, value] of Object.entries(set)) {
    if (key === keys.project) {
      // The count only goes up: another session may have raised it meanwhile.
      const now = storedOf(await $.store.get(key)).nextId
      await $.store.set(key, { nextId: Math.max(now, after.nextId) })
    } else {
      await $.store.set(key, value)
    }
  }

  for (const key of remove) {
    await $.store.delete(key)
  }
}

/** Changes the task list and keeps this session's slot of the project's store in step. */
async function change($: EngineInterface, fn: (list: readonly Task[]) => readonly Task[]) {
  const nowMs = await $.clock.now()
  const found = await readStore($)
  const stored = await letGo($, found)
  const list = await update($, tasks, fn)
  const counted = { ...stored, nextId: Math.max(stored.nextId, await read($, nextId)) }

  await writeStore($, found, withSlot(counted, live.sessionId, list, nowMs))
  live.elsewhere = elsewhereIn(stored, live.sessionId, nowMs)
  await refresh($)
}

/**
 * Keeps the status line in step with the tasks, and closes the pane once
 * nothing is left in it. Resolves whether anything is shown.
 */
async function refresh($: EngineInterface): Promise<boolean> {
  const shown = (await read($, tasks)).filter(isShown)

  $.ui.status(statusOf(shown, live.elsewhere))

  if (shown.length === 0) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
  }

  return shown.length > 0
}

/**
 * Opens the My tasks pane sized to what it holds; `isAsked` when the person
 * asked for it (/my-tasks), so it takes the keyboard. Resolves whether the
 * surface seated it: one opened unasked waits on a narrow terminal.
 */
async function show($: EngineInterface, isAsked: boolean): Promise<boolean> {
  const rows = rowsFor(await paneView($, live), live.columns, MAX_PANE_ROWS)
  live.rows = rows
  // The pane is a view of the tasks: one that can't open costs the user a
  // click on /my-tasks, never the task itself.
  const opened = await $.ui
    .open({ id: PANE, title: PANE_TITLE, rows, ...(isAsked ? { focus: true as const } : {}) })
    .catch(() => ({ isPlaced: false as const }))

  return opened.isPlaced
}

/** What the pane draws from: the session's state, and what only the surface knows. */
async function paneView($: EngineInterface, surface: Pick<PaneView, 'canType' | 'isFocused'>): Promise<PaneView> {
  const field = await read($, editing)

  return {
    shown: (await read($, tasks)).filter(isShown),
    selectedId: await read($, selectedId),
    editing: field,
    draft: field === null ? '' : (live.drafts.get(field.id) ?? ''),
    nowMs: await $.clock.now(),
    sessionId: live.sessionId,
    isWorking: await read($, isWorking),
    canType: surface.canType,
    isFocused: surface.isFocused,
  }
}

/** Re-sizes the pane to what it holds now, when it is on screen. */
async function fit($: EngineInterface) {
  const panes = await $.ui.panes().catch(() => [])

  if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    await show($, false)
  }
}

async function edit($: EngineInterface, id: number, fn: (task: Task) => Task) {
  const nowMs = await $.clock.now()

  await change($, list => list.map(task => (task.id === id ? { ...fn(task), updatedMs: nowMs } : task)))
}

async function delivered($: EngineInterface, ids: readonly number[]) {
  if (ids.length === 0) {
    return
  }

  await change($, list => list.map(task => (ids.includes(task.id) ? { ...task, update: 'delivered' } : task)))
}

/**
 * Passes on a typed prompt that carries `due` to Claude. They are marked
 * delivered first, so no other path sends them meanwhile; a prompt a hook
 * beneath drops, or that fails, gives them back, to go with the next send.
 */
async function passOn<R extends { drop?: unknown }>($: EngineInterface, due: readonly Task[], pass: () => Promise<R>): Promise<R> {
  const ids = due.map(one => one.id)

  await delivered($, ids)

  try {
    const result = await pass()

    if (result.drop !== undefined) {
      await undelivered($, ids)
    }

    return result
  } catch (error) {
    await undelivered($, ids)
    throw error
  }
}

/** Gives back updates marked delivered that never reached Claude: they wait again. */
async function undelivered($: EngineInterface, ids: readonly number[]) {
  await change($, list => list.map(task => (ids.includes(task.id) && task.update === 'delivered' ? { ...task, update: 'pending' } : task)))
}

/** Keeps the selection on a task still open, and drops a field whose task is gone. */
async function settle($: EngineInterface, id: number) {
  live.drafts.delete(id)
  await update($, editing, field => (field?.id === id ? null : field))
  await reselect($)
}

async function reselect($: EngineInterface) {
  const active = (await read($, tasks)).filter(isActive)

  await update($, selectedId, chosen => (active.some(task => task.id === chosen) ? chosen : (active[0]?.id ?? null)))
}

async function select($: EngineInterface, id: number) {
  await update($, selectedId, () => id)
  await update($, editing, field => (field?.id === id ? field : null))
  await fit($)
}

/** The user fulfilled or rejected a task; `how` says when Claude hears of it. */
async function resolve($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How) {
  await edit($, id, task => ({ ...task, ...patch, update: 'pending' }))
  await settle($, id)

  if (how === 'now' || (how === 'auto' && !working())) {
    sendSoon($)
  }
}

async function answer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false) {
  const value = text.trim()

  if (value === '') {
    $.ui.toast('Type an answer first, or press Cancel.')
    return
  }

  if (!isSecretOk && looksSecret(value)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: value }))
    return
  }

  await resolve($, id, { state: 'done', answer: value }, how)
}

async function startEditing($: EngineInterface, id: number, field: Editing['field']) {
  await update($, selectedId, () => id)
  await update($, editing, (): Editing => ({ id, field }))
  await fit($)

  // A field the pane can't focus (it doesn't hold the keyboard) is still a click away.
  void $.ui.focus({ requestId: PANE, key: field }).then(undefined, () => undefined)
}

async function stopEditing($: EngineInterface) {
  await update($, editing, () => null)
  await fit($)
}

/** Moves a long answer into the prompt box, where the real editor takes pastes and lines. */
async function longAnswer($: EngineInterface, id: number) {
  const box = await $.prompt.read()
  const draft = live.drafts.get(id) ?? ''
  const text = bridgeOf(id) + [draft, box.text].filter(part => part.trim() !== '').join('\n')
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast("Couldn't open the prompt box for your answer; type it here instead.")
    return
  }

  live.drafts.delete(id)
  await update($, editing, () => null)
  $.ui.toast('Write your answer in the prompt box (Esc gets you there), then press Enter.', {
    timeoutMs: 8000,
  })
}

function sendNow($: EngineInterface) {
  live.batch?.cancel()
  live.batch = null
  void send($)
}

function sendSoon($: EngineInterface) {
  live.batch?.cancel()
  live.batch = $.clock.after(BATCH_MS, () => {
    live.batch = null
    void send($)
  })
}

/**
 * Hands Claude every update it has not heard: a turn of its own while it is
 * idle, a row its running turn reads at the next step while it works.
 * `isTurnOver`: sent as main's turn ends, when Claude is idle whatever the
 * engine's last word on it was.
 */
async function send($: EngineInterface, isTurnOver = false) {
  const due = (await read($, tasks)).filter(task => task.update === 'pending')

  if (due.length === 0) {
    return
  }

  const text = messageOf(due)
  const ids = due.map(task => task.id)
  const which = ids.map(id => `#${id}`).join(', ')

  if (isTurnOver || !working()) {
    // Marked delivered first, so no other path sends them meanwhile; a prompt
    // that doesn't enter gives them back, to go with the next send.
    await delivered($, ids)
    const refused = await $.prompt.submit({ text, asUser: true }).then(
      entered => entered.drop,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    if (refused !== undefined) {
      await undelivered($, ids)
      const reason = printable(refused, 200).replace(/[.!]+$/, '')

      $.ui.toast(`Claude didn't get your response to ${which}: ${reason}. It's saved; press Send now in /my-tasks.`, {
        timeoutMs: 8000,
      })
    }

    return
  }

  const isTaken = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(
    appended => appended.deny === undefined,
    () => false,
  )

  if (!isTaken) {
    live.isSendingAtEnd = true
    $.ui.toast(`Claude gets your response to ${which} when it finishes this turn.`)
    return
  }

  live.isUnread = true
  await delivered($, ids)

  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Sent your response to ${which} to Claude` }] } })
  } catch {
    // The notice is for the user's eyes only; Claude has the answer either way.
  }
}
