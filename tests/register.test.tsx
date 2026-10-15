import type { On, PaneOpenArgs, PromptSubmitInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { rowsFor } from '../hooks/pane'
import { keysOf, storedFrom } from '../hooks/project'
import { cellsOf, rowsOf, wrapRows } from '../hooks/text'

const ASSIGN = 'mcp__human-in-the-loop__assign_task'
const LIST = 'mcp__human-in-the-loop__list_tasks'
const WITHDRAW = 'mcp__human-in-the-loop__withdraw_task'

const PANE = {
  plugin: 'human-in-the-loop',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'my-tasks',
  props: {
    title: 'My tasks',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DONE = {
  answer: 'Done.',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer',
  category: null,
  explanation: null,
} as const

const KEY_TASK = {
  tool: ASSIGN,
  title: 'Add STRIPE_SECRET_KEY to .env',
  why: "The webhook test can't run without it.",
  done_when: "It's in .env. Don't paste it here.",
  kind: 'do',
} as const

const XCODE_TASK = {
  tool: ASSIGN,
  title: 'Run xcodebuild test on your Mac, paste the failures',
  why: "I can't run Xcode here.",
  kind: 'answer',
} as const

const PAGING_TASK = {
  tool: ASSIGN,
  title: 'Pick a pagination strategy for /feed',
  why: 'I lean towards cursor: the feed is append-only.',
  kind: 'choose',
  options: ['Cursor', 'Offset, capped at 10k'],
} as const

const NOW = 1_000_000

/** A task an earlier or another session assigned. */
const ROTATE = {
  id: 7,
  title: 'Rotate the leaked token in Vault',
  why: 'It was in a public gist.',
  kind: 'do',
  state: 'open',
  update: 'none',
  sessionId: 'session-0',
  createdMs: 0,
  updatedMs: 0,
} as const

/**
 * Seats the engine beneath the plugin: a session, a store, a clock, panes
 * and a status line, and the calls the plugin makes to Claude, kept in
 * `world`. `isNarrow` makes a pane opened unasked wait, as a narrow
 * terminal does.
 */
function seat(on: On, store: Record<string, unknown> = {}) {
  const world = {
    submitted: [] as string[],
    appended: [] as { type: string; text: string }[],
    toasts: [] as string[],
    opens: [] as PaneOpenArgs[],
    isPaneOpen: false,
    isNarrow: false,
    status: undefined as string | undefined,
    composer: '',
    /** Set, the plugin's prompts don't enter: a hook beneath drops them with this reason. */
    refusing: undefined as string | undefined,
    /** Set, the user's typed prompts don't enter: a hook beneath (a settings hook, say) drops them with this reason. */
    refusingTyped: undefined as string | undefined,
    /** Set, the plugin's own rows don't enter the conversation: a hook beneath refuses them with this reason. */
    refusingRows: undefined as string | undefined,
    sessionId: 'session-1',
    store: JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
    /** Set, runs once just before the plugin's next store write: another session's write landing meanwhile. */
    landing: undefined as (() => void) | undefined,
  }

  const clock = mock.clock(on, { now: NOW })
  // The plugin's own store, kept where a test can read it.
  on('store.get', ($, e) => ({ value: world.store[e.key] }))
  on('store.set', ($, e) => {
    const landing = world.landing
    world.landing = undefined
    landing?.()
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete world.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(world.store) }))

  on('session.id', () => ({ value: world.sessionId }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__human-in-the-loop__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.status = e.text
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    world.opens.push(e)
    world.isPaneOpen = true
    const isPlaced = e.focus === true || !world.isNarrow
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }
  })
  on('ui.close', () => {
    world.isPaneOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: world.isPaneOpen ? [{ id: 'my-tasks', title: 'My tasks', isShown: true, isFocused: true, isPlaced: !world.isNarrow }] : [],
  }))
  on('ui.focus', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin' && world.refusing !== undefined) {
      return { drop: world.refusing }
    }

    if (e.origin.kind === 'composer' && world.refusingTyped !== undefined) {
      return { drop: world.refusingTyped }
    }

    if (e.origin.kind === 'plugin') {
      world.submitted.push(e.text)
    }

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('session.append', ($, e, next) => {
    // Only a plugin's own row may be refused; any other must go on with next.
    if (e.door === 'note' && world.refusingRows !== undefined) {
      return { deny: world.refusingRows }
    }

    const block = e.message.content[0] as { text?: string } | undefined
    world.appended.push({ type: e.message.type, text: block?.text ?? '' })

    return next(e)
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })
  on('prompt.read', () => ({ value: { text: world.composer, cursor: world.composer.length } }))
  on('prompt.fill', ($, e) => {
    world.composer = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  return { world, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

function typed(text: string, turnId?: string): PromptSubmitInput {
  return { text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) }
}

async function runTasks($: Engine) {
  return $.command.run({
    command: 'my-tasks',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

type Drawn = Pick<Mounted<'terminal', 'Pane'>, 'find'>

async function textOf(ui: Drawn, key: string): Promise<string> {
  return (await ui.find({ key }))?.text ?? ''
}

describe('assigning', () => {
  test('a task opens the Tasks pane, with its why and its buttons, and the status line counts it', async ($, on) => {
    const { world } = seat(on)
    await start($)

    const assigned = await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(world.opens.at(-1)?.focus).toBeUndefined()
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(await textOf(ui, 'head')).toContain('1 task for you')
    expect(await textOf(ui, 'task-1')).toContain("The webhook test can't run without it.")
    expect(await textOf(ui, 'task-1')).toContain('Done when:')
    expect(await textOf(ui, 'actions')).toContain('Done')
    expect(await textOf(ui, 'actions')).not.toContain('Accept')
    expect(world.toasts).toHaveLength(0)
  })

  test('where the pane cannot be seated unasked, a toast points at /my-tasks', async ($, on) => {
    const { world } = seat(on)
    world.isNarrow = true
    await start($)

    await $.tool.call(KEY_TASK)

    expect(world.toasts[0]).toBe('Claude assigned you a task: Add STRIPE_SECRET_KEY to .env. See /my-tasks')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('the same ask twice is one task, and a sixth open task is refused', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const again = await $.tool.call({ ...KEY_TASK, title: 'add stripe_secret_key to .env!' })
    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks')

    for (const n of [2, 3, 4, 5]) {
      await $.tool.call({ ...KEY_TASK, title: `Do thing number ${n}` })
    }

    const sixth = await $.tool.call({ ...KEY_TASK, title: 'One task too many' })
    expect((sixth as { deny?: string }).deny).toContain('already has 5 open tasks')
  })

  test('a subagent cannot assign tasks', async ($, on) => {
    seat(on)
    await start($)

    const call = { ...KEY_TASK, agentId: 'agent-1' } as unknown as Parameters<Engine['tool']['call']>[0]
    const refused = await $.tool.call(call)

    expect((refused as { deny?: string }).deny).toContain('Only the main agent')
  })

  test('a withdrawn task leaves: the pane closes and the status line clears', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found the key in the vault' })

    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Add STRIPE_SECRET_KEY to .env. Found the key in the vault')
  })
})

/**
 * Two tasks with titles near the 80 characters a title may have, as an
 * earlier session left them. The live check (tests/live/test_pane.py) draws
 * them in a real Claude Code; the row counts here are what it drew.
 */
const INSTRUMENTS = {
  ...ROTATE,
  id: 1,
  title: 'Open Instruments from Xcode and record with the Activity Monitor template',
  why: 'I need a trace of the launch to see where the 4 seconds go.',
  doneWhen: 'The .trace file is in ~/traces.',
  createdMs: NOW - 180_000,
} as const

const XCODE_LONG = {
  ...ROTATE,
  id: 2,
  title: 'Run xcodebuild test on your Mac and paste every failure you see here please',
  why: "I can't run Xcode here.",
  kind: 'answer',
  createdMs: NOW - 180_000,
} as const

/** The pane seated inline above the prompt, `bodyColumns` across. */
function inline(bodyColumns: number) {
  return { ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns } } as const
}

function earlier(tasks: readonly unknown[]) {
  return { 'tasks:/repo': { nextId: 3, sessions: { 'session-0': { tasks, seenMs: 0, endedMs: 0 } } } }
}

describe('long titles', () => {
  test('wrap as the terminal wraps them: at spaces, a word wider than the row broken where it ends', () => {
    expect(wrapRows(' a b c d e f g h i j k l m n o p q r s t u v w x y z A B C D E F G H I J  3m · from an earlier session', 32)).toEqual([
      ' a b c d e f g h i j k l m n o p',
      ' q r s t u v w x y z A B C D E F',
      ' G H I J  3m · from an earlier ',
      'session',
    ])
    expect(wrapRows('#3 Datenbankverbindungseinstellungsüberprüfungsprotokoll im Ordner ablegen', 30)).toEqual([
      '#3 Datenbankverbindungseinstel',
      'lungsüberprüfungsprotokoll im ',
      'Ordner ablegen',
    ])
    expect(cellsOf('ステージング')).toBe(12)
    expect(rowsOf('ステージング環境のデータベース移行を承認してください', 30)).toBe(2)
  })

  test('the pane asks for a row for each row a wrapped title takes, at the width it is drawn in', () => {
    const view = {
      shown: [INSTRUMENTS, XCODE_LONG],
      selectedId: null,
      editing: null,
      draft: '',
      nowMs: NOW,
      sessionId: 'session-1',
      isWorking: false,
      canType: true,
      isFocused: true,
    }

    // A title on one row would ask for 10 rows wherever it is drawn: the
    // rows Claude Code 2.1.296 drew at 36 and 64 columns, as the live check reads them.
    expect(rowsFor(view, 32, 99)).toBe(18)
    expect(rowsFor(view, 60, 99)).toBe(12)
    expect(rowsFor({ ...view, shown: [INSTRUMENTS] }, 32, 99)).toBe(14)
    expect(rowsFor({ ...view, shown: [INSTRUMENTS] }, 60, 99)).toBe(10)
    expect(rowsFor(view, 32, 18)).toBe(18)
  })

  test('drawn narrow, the pane opens again as tall as its wrapped titles', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(60))
    expect(world.opens.at(-1)?.rows).toBe(12)

    // The terminal narrows: the titles take more rows, and the pane asks for them.
    await ui.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test('every open task shows its whole title, wrapping, with its age after it in the same text', async ($, on) => {
    seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    const ui = await $.ui.mount(inline(32))
    const selected = await ui.find({ type: 'Text', text: /Open Instruments/ })
    const other = await ui.find({ type: 'Text', text: /Run xcodebuild/ })

    expect(selected?.props.wrap).toBe('wrap')
    expect(selected?.text).toBe(`#1 ${INSTRUMENTS.title}  3m · from an earlier session`)
    expect(other?.props.wrap).toBe('wrap')
    expect(other?.text).toBe(` ${XCODE_LONG.title}  3m · from an earlier session`)
    expect((await ui.find({ type: 'Button', key: 'select-2' }))?.props.label).toBe('#2')
  })

  test('a title past 80 characters, an older version left, is drawn whole', async ($, on) => {
    const title = `Rotate the deploy key ${'and check every runner that holds it '.repeat(3).trim()}`
    seat(on, earlier([{ ...INSTRUMENTS, title }, { ...XCODE_LONG, title, state: 'done', update: 'pending' }]))
    await start($)

    const ui = await $.ui.mount(inline(32))

    expect(title.length).toBeGreaterThan(80)
    expect(await textOf(ui, 'task-1')).toContain(title)
    expect(await textOf(ui, 'saved-2')).toContain(`#2 ${title} · not sent yet`)
  })

  test('the transcript row keeps its label whole and wraps the title after it', async ($, on) => {
    seat(on)
    await start($)

    const ui = await $.ui.mount({
      plugin: 'human-in-the-loop',
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        tool_use_id: 'toolu_1',
        tool: ASSIGN,
        input: { title: XCODE_LONG.title },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    })
    // One text, outermost: no row of columns for the label to be squeezed in.
    const row = await ui.find({ type: 'Text' })

    expect((await ui.drawn()).type).toBe('Text')
    expect(row?.props.wrap).toBe('wrap')
    expect(row?.text).toBe(`☐ Assigned you a task: ${XCODE_LONG.title}`)
  })
})

describe('the pane and /my-tasks', () => {
  test('/my-tasks opens the pane with the keyboard, or says there is nothing', async ($, on) => {
    const { world } = seat(on)
    await start($)

    expect((await runTasks($)).text).toBe('No tasks for you right now.')

    await $.tool.call(KEY_TASK)
    await runTasks($)

    expect(world.opens.at(-1)?.focus).toBe(true)
  })

  test('Hide closes the pane and the status line keeps the count', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'hide' })

    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })
})

describe('responding', () => {
  test('Done while Claude is idle is sent to Claude as a message, and the pane closes', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toBe('My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.')
    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBeUndefined()
  })

  test('an answer while Claude works is saved, and goes when its turn ends', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer' }))?.props.placeholder).toBe('Enter saves it; Claude gets it when this turn ends')
    await ui.input({ key: 'answer', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.appended).toHaveLength(0)
    expect(await textOf(ui, 'saved-1')).toContain('not sent yet')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken failed',
    ])
    expect(world.status).toBeUndefined()
  })

  test('with a task still open, a saved answer waits for it, or rides along with the next prompt', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer' }))?.props.placeholder).toBe('Enter saves it; Claude gets it with your other answers')
    await ui.input({ key: 'answer', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('#1 done: Run xcodebuild test on your Mac, paste the failures.')
    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test('a saved answer riding a typed prompt that a hook beneath drops waits for the next one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.refusingTyped = 'Blocked by your organization.'
    const blocked = await $.prompt.submit(typed('now the cart'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.refusingTyped = undefined
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('Send now while Claude works reaches it in the turn', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.appended.map(row => row.type)).toEqual(['user', 'system'])
    expect(world.appended[0]?.text).toContain('CartTests.testCouponRounding')
    expect(world.appended[1]?.text).toBe('Sent your response to #1 to Claude')
    expect(world.toasts).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // Claude has the row already, so the answer doesn't go again; but no step
    // read it before the turn ended, so a one-line prompt wakes Claude for it.
    expect(world.submitted).toEqual(['I answered a task while you were finishing your reply; my answer is above.'])
  })

  test('Send now that the running turn refuses goes the moment the turn ends', async ($, on) => {
    const { world, clock } = seat(on)
    world.refusingRows = 'No conversation to append to.'
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Claude gets your response to #1 when it finishes this turn.')
    expect(world.appended).toHaveLength(0)
    expect(world.submitted).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('CartTests.testCouponRounding')
  })

  test('a choice and a rejection reach Claude together', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'option-1' })
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'reason', text: 'I will do it after the deploy' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('#1 Pick a pagination strategy for /feed: I chose "Cursor".')
    expect(world.submitted[0]).toContain("#2 Add STRIPE_SECRET_KEY to .env: I won't do this. I will do it after the deploy")
  })

  test("a response whose prompt doesn't enter stays saved, and Send now tries again", async ($, on) => {
    const { world, clock } = seat(on)
    world.refusing = 'Another plugin held the prompt.'
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.toasts.at(-1)).toBe(
      "Claude didn't get your response to #1: Another plugin held the prompt. It's saved; press Send now in /my-tasks.",
    )
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    world.refusing = undefined
    await runTasks($)
    await ui.press({ key: 'send-1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBeUndefined()
  })

  test('an answer that looks like a secret is held', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: 'sk_live_51HxAbCdEfGhIjKlMnOp' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(await textOf(ui, 'held')).toContain('looks like a secret')
  })

  test('list_tasks shows a saved answer and marks it heard', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: 'Two failures' })

    const listed = await $.tool.call({ tool: LIST })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
    expect(world.isPaneOpen).toBe(false)
  })
})

describe('long answers in the prompt box', () => {
  test('typed while Claude is idle, the prompt is the answer', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'long' })
    expect(world.composer).toBe('↳ Answer to #1: ')

    const sent = await $.prompt.submit(typed('↳ Answer to #1: LoginTests.testExpiredToken\nCartTests.testCouponRounding'))

    expect(sent.text).toContain('#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken\nCartTests.testCouponRounding')
  })

  test('typed while Claude is idle and dropped by a hook beneath, the answer is kept to send', async ($, on) => {
    const { world } = seat(on)
    world.refusingTyped = 'Blocked by your organization.'
    await start($)

    await $.tool.call(XCODE_TASK)
    const blocked = await $.prompt.submit(typed('↳ Answer to #1: Two failures'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')
  })

  test('typed while Claude works, it is saved instead of sent', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const result = await $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))

    expect(result.drop).toContain('Saved as your answer to #1')

    const listed = await $.tool.call({ tool: LIST })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
  })
})

describe('the system prompt', () => {
  const COMPOSE = {
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    outputStyle: null,
  } as const

  test('tells Claude to assign what only the user can do, where the tool can be reached', async ($, on) => {
    seat(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await start($)

    const offered = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', ASSIGN], traits: [] })
    const deferred = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', 'ToolSearch'], traits: [] })
    const headless = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', ASSIGN], traits: ['print'] })
    const without = await $.prompt.compose({ ...COMPOSE, tools: ['Bash'], traits: [] })

    expect(offered.sections.at(-1)?.id).toBe('human-in-the-loop:tasks')
    expect(offered.sections.at(-1)?.scope).toBe('session')
    expect(offered.sections.at(-1)?.text).toContain('assign it with mcp__human-in-the-loop__assign_task so it stays in front of them')
    expect(offered.sections.at(-1)?.text).toContain('or opens it with /my-tasks')
    expect(offered.sections.at(-1)?.text).toContain('review or approve your work: assign it as a task even when you also ask in your reply')
    expect(deferred.sections.at(-1)?.id).toBe('human-in-the-loop:tasks')
    expect(headless.sections).toHaveLength(1)
    expect(without.sections).toHaveLength(1)
  })
})

describe('across sessions', () => {
  const KEYS = keysOf('/repo')

  /** The project as the store holds it, across its keys. */
  function projectIn(store: Record<string, unknown>) {
    return storedFrom('/repo', store) as { nextId: number; sessions: Record<string, { tasks: { id: number }[]; seenMs: number; endedMs?: number }>; taken: Record<string, unknown> }
  }

  test("the first store layout's open tasks come back in the next session, and Claude is told", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 8,
        tasks: [
          {
            id: 7,
            title: 'Rotate the leaked token in Vault',
            why: 'It was in a public gist.',
            kind: 'do',
            state: 'open',
            update: 'none',
            sessionId: 'session-0',
            createdMs: 0,
            updatedMs: 0,
          },
        ],
      },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-7')).toContain('from an earlier session')

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks.at(-1)?.text).toContain('#7 open (from an earlier session): Rotate the leaked token in Vault')

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
  })

  test("a live session's tasks stay in it: this one counts them but neither shows nor answers them", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000 } } },
    })
    await start($)

    expect(world.opens).toHaveLength(0)
    expect(world.status).toBe('1 task in another session')

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks).toHaveLength(0)

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')

    const stored = projectIn(world.store)
    expect(stored.sessions['session-0']?.tasks.map(task => task.id)).toEqual([7])
    expect(stored.sessions['session-1']?.tasks.map(task => task.id)).toEqual([8])
    // The older layout's slots moved to keys of their own; the project's key keeps the count.
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9 })
    expect(world.store[KEYS.session('session-0')]).toEqual({ tasks: [ROTATE], seenMs: NOW - 30_000 })
  })

  test("another session's write landing between this one's read and write stays", async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 30_000 } })
    await start($)
    await $.tool.call(KEY_TASK)

    // Session 0 saves an answer while this session's heartbeat is between its read and its write.
    const answered = { ...ROTATE, state: 'done', update: 'pending' }
    world.landing = () => {
      world.store[KEYS.session('session-0')] = { tasks: [answered], seenMs: NOW + 30_000 }
    }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.landing).toBeUndefined()
    const stored = projectIn(world.store)
    expect(stored.sessions['session-0']).toEqual({ tasks: [answered], seenMs: NOW + 30_000 })
    expect(stored.sessions['session-1']?.seenMs).toBe(NOW + 60_000)
  })

  test("an ended session's tasks, and a quiet one's, are taken on by the next session", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 9,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': { tasks: [{ ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }], seenMs: NOW - 10 * 60_000 },
        },
      },
    })
    await start($)

    const ui = await $.ui.mount(PANE)
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(await textOf(ui, 'task-7')).toContain('from an earlier session')

    // The quiet one may come back (a laptop asleep): the store notes what it lets go of then.
    const stored = projectIn(world.store)
    expect(Object.keys(stored.sessions)).toEqual(['session-1'])
    expect(stored.taken).toEqual({ 'session-x': { ids: [8], atMs: NOW } })
  })

  test('where two sessions drew one number, the session taking on both gives the later a new one', async ($, on) => {
    seat(on, {
      'tasks:/repo': {
        nextId: 8,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': {
            tasks: [{ ...ROTATE, title: 'Approve the staging migration', sessionId: 'session-x' }],
            seenMs: NOW - 60_000,
            endedMs: NOW - 60_000,
          },
        },
      },
    })
    await start($)

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks.at(-1)?.text).toContain('#7 open (from an earlier session): Rotate the leaked token in Vault')
    expect(context.blocks.at(-1)?.text).toContain('#8 open (from an earlier session): Approve the staging migration')

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
  })

  /** The store as another session leaves it on taking on session-1's tasks while session-1 slept. */
  function takeOn(store: Record<string, unknown>) {
    const mine = projectIn(store).sessions['session-1']?.tasks ?? []

    delete store[KEYS.session('session-1')]
    store[KEYS.session('session-2')] = { tasks: mine, seenMs: NOW }
    store[KEYS.taken('session-1')] = { ids: mine.map(task => task.id), atMs: NOW }
  }

  test('a session back from sleep lets go of the tasks another session took on meanwhile', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    takeOn(world.store)
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on tasks #1, #2 while this one was away. Answer them there.')
    expect(world.status).toBe('2 tasks in another session')
    expect(world.isPaneOpen).toBe(false)

    const stored = projectIn(world.store)
    expect(Object.keys(stored.sessions)).toEqual(['session-2'])
    expect(stored.sessions['session-2']?.tasks.map(task => task.id)).toEqual([1, 2])
    expect(stored.taken).toEqual({})
  })

  test('a task assigned on waking keeps its place, the ones taken on elsewhere go', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    const assigned = await $.tool.call(XCODE_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #2')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')

    const stored = projectIn(world.store)
    expect(stored.sessions['session-1']?.tasks.map(task => task.id)).toEqual([2])
    expect(stored.sessions['session-2']?.tasks.map(task => task.id)).toEqual([1])
  })

  test('the heartbeat keeps the slot alive and counts tasks other sessions take on', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW }
    await clock.advance(60_000)
    await clock.settle()

    const stored = projectIn(world.store)
    expect(stored.sessions['session-1']?.seenMs).toBe(NOW + 60_000)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
  })

  test('an ending session leaves its tasks for the next, and after /clear takes them on again', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    const ended = projectIn(world.store)
    expect(ended.sessions['session-1']?.endedMs).toBe(NOW)

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')

    const cleared = projectIn(world.store)
    expect(Object.keys(cleared.sessions)).toEqual(['session-2'])
  })
})

describe('the README example', () => {
  test('two answers while Claude works, the third after it stops, reach Claude as one message', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.turn.start({ text: 'Get our Stripe webhooks library ready to open-source.', turnId: 't1' })
    await $.tool.call({
      tool: ASSIGN,
      title: 'Add STRIPE_SECRET_KEY to .env',
      why: "The integration tests run against Stripe's test mode and need it.",
      done_when: "It's in .env. Don't paste it here.",
      kind: 'do',
    })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.tool.call({
      tool: ASSIGN,
      title: 'Decide whether to make the repo public',
      why: 'npm will link to it, and its whole git history becomes public. I found no secrets in it.',
      kind: 'choose',
      options: ['Make it public', 'Keep it private'],
    })
    await ui.press({ key: 'option-1' })

    await $.tool.call({
      tool: ASSIGN,
      title: "Choose the package's name on npm",
      why: 'stripe-webhooks is taken. The name goes in package.json and the README.',
      kind: 'answer',
    })
    expect(world.status).toBe('☐ 1 task for you · 2 not sent yet · /my-tasks')
    await clock.advance(1000)
    expect(world.submitted).toHaveLength(0)

    // #3 is still open when Claude stops, so #1 and #2 wait to go with it.
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()
    expect(world.submitted).toHaveLength(0)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer', text: '@acme/stripe-hooks' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      [
        'My responses to tasks you gave me (Human in the loop):',
        '',
        '#1 Add STRIPE_SECRET_KEY to .env: Done.',
        '',
        '#2 Decide whether to make the repo public: I chose "Make it public".',
        '',
        "#3 Choose the package's name on npm:",
        '@acme/stripe-hooks',
      ].join('\n'),
    ])
    expect(world.status).toBeUndefined()
  })
})

describe('knowing whether Claude works', () => {
  const BAND = {
    plugin: 'human-in-the-loop',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as const

  test('a turn another loop begins and ends under its agent id leaves Claude idle', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await $.turn.start({ text: '', turnId: 'side' })
    await $.turn.complete({ ...DONE, turnId: 'side', agentId: 'side-request' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
  })

  test("the engine's word that no turn runs wins over a turn that never ended", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: '', turnId: 'never-ends' })
    const band = await $.ui.mount(BAND)
    await band.redraw({ ...BAND.props, isWorking: true })
    await band.redraw({ ...BAND.props, isWorking: false })
    await clock.advance(1)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(await band.find({ key: 'engine' })).toBeDefined()
  })
})
