import type { On, PaneOpenArgs, PromptSubmitInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { fieldRowsOf, rowsFor } from '../hooks/pane'
import { keysOf, projectOf } from '../hooks/project'
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

/** Has the shape of a Stripe key, which `looksSecret` holds; built here, so no file carries one. */
const KEY_SHAPED = `sk_live_${'0'.repeat(24)}`

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
    root: '/repo',
    store: JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
    /** Set, runs once just before the plugin's next store write: another session's write landing meanwhile. */
    landing: undefined as (() => void) | undefined,
    /** Every store call the plugin makes, in order: `get <key>`, `set <key>`, `delete <key>` or `keys`. */
    ops: [] as string[],
    /** Set, the plugin's store calls fail: its file locked too long, or out of reach. */
    isStoreFailing: false,
    /** How many of the plugin's next store calls fail, as a store failing a moment does. */
    failing: 0,
    /** Set, the plugin's store writes fail and its reads go on: a disk full, say. */
    isWriteFailing: false,
    /** Set, the store's next keys() doesn't answer until `unstick`: a store stuck on a slow disk. */
    isStuck: false,
    unstick: undefined as (() => void) | undefined,
    /** How long the plugin's store writes take. */
    setMs: 0,
    /** Set, the plugin's next read of this value of its state, past `fastReads` more, answers `readMs` late, with the value as it stood when asked. */
    slowRead: undefined as string | undefined,
    fastReads: 0,
    readMs: 0,
    /** Set, a hook beneath takes the context out of the user's typed prompts. */
    isStripping: false,
    /** Set, a hook beneath rewrites the user's typed prompts and their context with it (masks a secret, say). */
    rewriting: undefined as ((text: string) => string) | undefined,
    /** Set, a hook beneath rewrites every prompt, the plugin's own among them, and their context with it. */
    masking: undefined as ((text: string) => string) | undefined,
    /** Set, the user's typed prompts fail beneath: nothing there answers them, and the engine rejects them. */
    isTypedFailing: false,
    /** How long the plugin's own rows take to join the conversation. */
    appendMs: 0,
    /** How long the surface takes to open a pane. */
    openMs: 0,
    /** How long the surface takes to say which panes are open: it says so as they were when asked. */
    panesMs: 0,
    /** How long the engine takes to attach a client once the plugin's hooks have seen it. */
    attachMs: 0,
    /** Set, the engine can't list the plugin's panes. */
    isPanesFailing: false,
    /** How many times the plugin asked which of its panes are open. */
    panesAsked: 0,
    /** How many times the plugin read its task list. */
    tasksRead: 0,
  }

  const clock = mock.clock(on, { now: NOW })
  // The plugin's own store, kept where a test can read it. Its keys run to
  // 256 characters, as the engine's do; a refusal rejects the plugin's call.
  const refused = (op: string, key?: string) => {
    world.ops.push(key === undefined ? op : `${op} ${key}`)
    const isFailing = world.failing > 0
    world.failing -= isFailing ? 1 : 0

    if (world.isStoreFailing || isFailing || (world.isWriteFailing && (op === 'set' || op === 'delete'))) {
      return { deny: 'The store is locked.' }
    }

    return key !== undefined && key.length > 256 ? { deny: `Store keys run to 256 characters; this one has ${key.length}.` } : undefined
  }
  on('store.get', ($, e) => refused('get', e.key) ?? { value: world.store[e.key] })
  on('store.set', async ($, e) => {
    const refusal = refused('set', e.key)

    if (refusal !== undefined) {
      return refusal
    }

    if (world.setMs > 0) {
      await clock.sleep(world.setMs)
    }

    const landing = world.landing
    world.landing = undefined
    landing?.()
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    const refusal = refused('delete', e.key)

    if (refusal !== undefined) {
      return refusal
    }

    delete world.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => {
    if (world.isStuck) {
      world.isStuck = false
      return new Promise<{ value: string[] }>(resolve => {
        world.unstick = () => resolve({ value: Object.keys(world.store) })
      })
    }

    return refused('keys') ?? { value: Object.keys(world.store) }
  })

  on('state.get', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
    const read = await next(e)
    world.tasksRead += e.key === 'tasks' ? 1 : 0

    if (e.key === world.slowRead && world.fastReads > 0) {
      world.fastReads -= 1
    } else if (e.key === world.slowRead) {
      world.slowRead = undefined
      await clock.sleep(world.readMs)
    }

    return read
  })

  on('session.id', () => ({ value: world.sessionId }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.attach', async ($, e) => {
    if (world.attachMs > 0) {
      await clock.sleep(world.attachMs)
    }

    return { clientId: e.clientId }
  })
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  on('session.root', () => ({ value: world.root }))
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
  on('ui.open', async ($, e) => {
    if (world.openMs > 0) {
      await clock.sleep(world.openMs)
    }

    world.opens.push(e)
    world.isPaneOpen = true
    const isPlaced = e.focus === true || !world.isNarrow
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }
  })
  on('ui.close', () => {
    world.isPaneOpen = false
    return { value: undefined }
  })
  on('ui.panes', async () => {
    world.panesAsked += 1

    if (world.isPanesFailing) {
      return { deny: 'The surface is busy.' }
    }

    const value = world.isPaneOpen ? [{ id: 'my-tasks', title: 'My tasks', isShown: true, isFocused: true, isPlaced: !world.isNarrow }] : []

    if (world.panesMs > 0) {
      await clock.sleep(world.panesMs)
    }

    return { value }
  })
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

    if (e.origin.kind === 'composer' && world.isTypedFailing) {
      // A hook that throws is skipped; with none beneath it, the engine rejects the prompt.
      throw new Error('The prompt hook timed out.')
    }

    if (e.origin.kind === 'composer' && world.isStripping) {
      return { text: e.text }
    }

    if (e.origin.kind === 'plugin') {
      world.submitted.push(e.text)
    }

    const rewrite = (e.origin.kind === 'composer' ? world.rewriting : undefined) ?? world.masking

    if (rewrite !== undefined) {
      return { text: rewrite(e.text), ...(e.context === undefined ? {} : { context: e.context.map(rewrite) }) }
    }

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('session.append', async ($, e, next) => {
    if (e.door === 'note' && world.appendMs > 0) {
      await clock.sleep(world.appendMs)
    }

    // Only a plugin's own row may be refused; any other must go on with next.
    if (e.door === 'note' && world.refusingRows !== undefined) {
      return { deny: world.refusingRows }
    }

    const block = e.message.content[0] as { text?: string } | undefined
    world.appended.push({ type: e.message.type, text: block?.text ?? '' })

    return next(e)
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.read', () => ({ value: { text: world.composer, cursor: world.composer.length } }))
  on('prompt.fill', ($, e) => {
    world.composer = e.mode === 'append' ? world.composer + e.text : e.text
    return { isFilled: true, text: world.composer, cursor: world.composer.length }
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

/**
 * Set, holds the next press short of its button until `letGo`: a press from
 * a drawing a write has changed since, before the drawing it wakes lands.
 */
function holdingPresses(on: On) {
  const held = { isOn: false, letGo: () => {} }

  on('ui.press', async ($, e, next) => {
    if (held.isOn) {
      held.isOn = false
      await new Promise<void>(resolve => {
        held.letGo = resolve
      })
    }

    return next(e)
  })

  return held
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

  test("the tools stay in the prompt's list, where the engine puts an MCP tool behind ToolSearch", async ($, on) => {
    seat(on)
    on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
    await start($)

    for (const tool of [ASSIGN, LIST, WITHDRAW]) {
      const described = await $.tool.describe({ tool, description: 'From the server.', isDeferred: true, provider: { plugin: 'human-in-the-loop', tier: 'user' } })

      expect(described).toEqual({ description: 'From the server.', isDeferred: false })
    }
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

  test('count an emoji as the terminal draws it: two cells, however it is built', () => {
    // Drawn as emoji by default, below U+1F300 too.
    expect(cellsOf('⌛ ✅ ⚡ ⭐ 🀄 🈯')).toBe(17)
    // An emoji drawn as text unless U+FE0F asks otherwise.
    expect(cellsOf('☀ 🌡')).toBe(3)
    expect(cellsOf('☀️ 🌡️ ⚠️')).toBe(8)
    // A keycap, a skin tone, a flag, and emoji joined by U+200D.
    expect(cellsOf('1️⃣ 👍🏽 🇮🇱 👩‍💻 🫱🏼‍🫲🏿')).toBe(14)
    // Without U+FE0F: a keycap, and an emoji drawn as text joined to another.
    expect(cellsOf('1⃣ ❤‍🔥 ❤‍🩹')).toBe(8)
    // A digit, `©` and `®` stay text.
    expect(cellsOf('9️ ©‍🔥')).toBe(5)
    // Marks and format characters take no cell of their own, nor a Hangul vowel and final spelled apart.
    expect(cellsOf('é​')).toBe(1)
    expect(cellsOf('각')).toBe(2)
    expect(rowsOf('Fix the ⏳ timeouts ✅ before the ⛔ freeze', 20)).toBe(3)
  })

  test('break a word wider than the row between the characters the terminal draws, never inside one', () => {
    // A skin tone stays on its hand, U+FE0F on its sun, emoji joined by U+200D together, and a conjunct with its vowel sign.
    expect(wrapRows('👍🏽👍🏽👍🏽👍🏽👍🏽', 9)).toEqual(['👍🏽👍🏽👍🏽👍🏽', '👍🏽'])
    expect(wrapRows('Status:☀️', 8)).toEqual(['Status:', '☀️'])
    expect(wrapRows('Pair 👩‍💻👩‍💻👩‍💻👩‍💻', 7)).toEqual(['Pair 👩‍💻', '👩‍💻👩‍💻👩‍💻'])
    expect(wrapRows('नमस्ते', 3)).toEqual(['नम', 'स्ते'])
    // A row one cell wide: a wide character goes on a row past it, after an empty one where the row before is full.
    expect(wrapRows('一二', 1)).toEqual(['', '一', '二'])
    expect(wrapRows('a一', 1)).toEqual(['a', '', '一'])
  })

  test('count East Asian wide forms two cells, and the ambiguous ones one', () => {
    expect(cellsOf('〈☰⚊䷀ꥠ︐﹐\u{16FE0}\u{17000}\u{1B000}\u{1D300}\u{1F200}')).toBe(24)
    expect(cellsOf('㉈')).toBe(1)
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
      isTyping: false,
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

  test('drawn on two surfaces at once, the pane asks for the rows the narrower takes, and keeps them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const phone = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // Each draws again: the pane asks for nothing new.
    const opens = world.opens.length
    await terminal.redraw(inline(60).props)
    await phone.redraw(inline(32).props)
    expect(world.opens.length).toBe(opens)

    // The phone leaves: the pane fits the terminal.
    await phone.unmount()
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a surface that docks the pane it drew inline leaves it as tall as the surfaces still drawing it inline', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(32))
    await $.ui.mount({ ...inline(60), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The terminal widens and docks the pane: the phone's rows are the pane's.
    await terminal.redraw(PANE.props)
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('drawn by two clients of one surface, the pane asks for the rows the narrower takes, and keeps them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    // A render names its surface, not its client: the tablet's and the phone's come as one surface's.
    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(60), surface: 'mobile' })
    await mobile.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(17)

    // Each draws again: the pane asks for nothing new.
    const opens = world.opens.length
    await mobile.redraw(inline(60).props)
    await mobile.redraw(inline(32).props)
    expect(world.opens.length).toBe(opens)

    // The phone leaves: the tablet drawing again, the pane fits it, and
    // follows it as it widens.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await mobile.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)

    await mobile.redraw(inline(100).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(11)
  })

  test("of two clients of one surface, one drawing it otherwise again and again keeps the other's rows", async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    // The tablet takes the keys and gives them back, turned one way and the other.
    for (const [columns, isFocused] of [[60, false], [60, true], [90, false], [90, true]] as const) {
      await mobile.redraw({ ...inline(columns).props, isFocused })
    }

    expect(world.opens.at(-1)?.rows).toBe(17)
  })

  test('a client of two leaving, the pane asks for none of the rows it took', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(60), surface: 'mobile' })
    await mobile.redraw(inline(32).props)
    await mobile.redraw(inline(60).props)
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The phone leaves, and the tablet draws the pane again: the pane fits it and the terminal.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a client of three leaving, the two left draw the pane again, and it fits them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    for (const clientId of ['phone', 'tablet', 'laptop']) {
      await $.session.attach({ surface: 'mobile', clientId })
    }

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await mobile.redraw(inline(60).props)
    await mobile.redraw(inline(50).props)
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The phone leaves. No surface seats the pane inline but theirs, and the
    // narrower of the two drew last.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(14)
  })

  test('two clients of one surface leaving at once, the pane fits the surfaces left', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // Both leave together, and the phone reads who is attached late: the tablet still is.
    await mobile.unmount()
    world.slowRead = 'clients'
    world.readMs = 500
    const leaving = Promise.all([
      $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' }),
      $.session.detach({ surface: 'mobile', clientId: 'tablet', reason: 'detach' }),
    ])
    await clock.advance(500)
    await leaving
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test("clients leaving as the roster's write answers late, the pane still fits those left", async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    let lateMs = 0
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      const set = await next(e)

      if (e.key === 'clients' && lateMs > 0) {
        await clock.sleep(lateMs)
      }

      return set
    })
    await start($)

    for (const clientId of ['laptop', 'tablet', 'phone']) {
      await $.session.attach({ surface: 'mobile', clientId })
    }

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await mobile.redraw(inline(50).props)
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The pane draws again before the write that wakes it answers: the two
    // left start their seats over, and once they leave too, the terminal's fit.
    lateMs = 100
    const phoneLeaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.advance(100)
    await phoneLeaving
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(14)

    await mobile.unmount()

    for (const clientId of ['tablet', 'laptop']) {
      const leaving = $.session.detach({ surface: 'mobile', clientId, reason: 'detach' })
      await clock.advance(100)
      await leaving
    }

    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test("a client leaving and attaching again as the roster's write answers late keeps the rows it draws", async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    const lateMs: number[] = []
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      const ms = e.key === 'clients' ? (lateMs.shift() ?? 0) : 0
      const set = await next(e)

      if (ms > 0) {
        await clock.sleep(ms)
      }

      return set
    })
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The phone drops and comes back, drawing the pane, before the write of
    // its leaving answers: the seat it draws stays.
    lateMs.push(100)
    await mobile.unmount()
    const leaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    const attaching = $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await clock.advance(100)
    await Promise.all([leaving, attaching])

    await terminal.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(17)
  })

  test('a client leaving and attaching again stays counted, though the write of its leaving lands late', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    let lateMs = 0
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      if (e.key === 'clients' && lateMs > 0) {
        const ms = lateMs
        lateMs = 0
        await clock.sleep(ms)
      }

      return next(e)
    })
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The phone drops and attaches again, and the write of its leaving lands
    // after the engine has it back: it stays counted, so a tablet attaching
    // next draws as one of two.
    lateMs = 100
    await mobile.unmount()
    const leaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    const attaching = $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await clock.advance(100)
    await Promise.all([leaving, attaching])

    const phone = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await phone.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(17)
  })

  test('the last client of a surface leaving as it draws the pane, the pane asks for none of the rows that drawing takes', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The phone draws the pane again and leaves before that drawing reads who is attached.
    world.slowRead = 'clients'
    world.readMs = 100
    const drawing = mobile.redraw(inline(32).props)
    await clock.settle()
    await mobile.unmount()
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.advance(100)
    await drawing.catch(() => undefined)

    await terminal.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a client is counted before it first draws the pane', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(17)

    // The tablet draws as it attaches, before the engine is done attaching it.
    world.attachMs = 500
    const attached = $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await clock.advance(1)
    await mobile.redraw(inline(60).props)
    await clock.advance(500)
    await attached
    await clock.settle()

    expect(world.opens.at(-1)?.rows).toBe(17)
  })

  test("the clients attached are kept in the session's state, which a reload of the code keeps", async ($, on) => {
    seat(on)
    let roster: unknown
    on('state.set', { plugin: 'human-in-the-loop' }, ($, e, next) => {
      roster = e.key === 'clients' ? e.value : roster
      return next(e)
    })
    await start($)

    await $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })

    expect(roster).toEqual({ mobile: ['tablet'], desktop: ['laptop'] })
  })

  test('re-sizing the pane, a drawing or a keystroke reads the tasks once', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(60))
    world.tasksRead = 0
    await ui.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(18)
    expect(world.tasksRead).toBe(1)

    await ui.redraw(inline(100).props)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0
    world.tasksRead = 0
    await ui.input({
      key: 'answer-2',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error in the total',
      kind: 'change',
    })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)
    expect(world.tasksRead).toBe(1)
  })

  test('docked beside the transcript, the terminal asks for no rows of its own', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 32 } })
    await $.ui.mount({ ...inline(60), surface: 'mobile' })

    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('the last task leaving, the pane closes and asks for no rows as it goes', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(inline(60))
    const opens = world.opens.length
    // Drawn empty while the withdraw writes the store, before the pane closes.
    world.setMs = 1000
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(1)
    await ui.redraw(inline(60).props)
    await clock.advance(1000)
    await withdrawn

    expect(world.opens.length).toBe(opens)
    expect(world.isPaneOpen).toBe(false)
  })

  test('re-sizing as its last task leaves, the pane stays closed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({ key: 'answer-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // The answer, cut short, takes a row less, and the pane re-sizes reading
    // the tasks late: Claude withdraws the task meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const typing = ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found them in the CI logs' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
  })

  test('a re-size the surface answers late, as Claude withdraws the last task, leaves the pane closed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0

    // The answer takes a row more, and the surface says late, as it was when
    // asked, that the pane is open: Claude withdraws the task meanwhile.
    world.panesMs = 500
    const typing = ui.input({ key: 'answer-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found them in the CI logs' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
    expect(world.opens.at(-1)?.rows).toBe(rows)
  })

  test('a re-size the surface answers late, as the pane is hidden, leaves it hidden', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'answer' })

    world.panesMs = 500
    const typing = ui.input({ key: 'answer-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    await clock.advance(1)
    await ui.press({ key: 'hide' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
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

  test('a focused field wraps its text a column short of the field, for the cursor', () => {
    // 60 across: `Answer: ` and ` ⏎ send` leave the field 45 columns, its text 44.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(44), true, 60)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(45), true, 60)).toBe(2)
    // Out of the keys, the text is cut to one row, and the label, cut short, wraps onto a second:
    // as Claude Code 2.1.296 drew 56 and 57 characters at 64 columns.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(56), false, 60)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(57), false, 60)).toBe(2)
    // However narrow the pane, the terminal gives the field 12 columns, its text 11.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(22), true, 20)).toBe(2)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(23), true, 20)).toBe(3)
  })

  test('a row too narrow for the label, the field and the hint takes its lack from each, and what is cut short wraps onto a second', () => {
    // As Claude Code 2.1.296 drew them at 30, 29 and 28 columns: bodies 26, 25 and 24 across.
    // The placeholder takes the field's 12 columns, the text its cells and the cursor's: a row a cell short cuts only the field.
    expect(fieldRowsOf('Answer', 'send', '', true, 26)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', '', true, 25)).toBe(2)
    expect(fieldRowsOf('Reason', 'reject', '', true, 26)).toBe(2)
    expect(fieldRowsOf('Answer', 'send', 'abc', true, 24)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghij', true, 25)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghijk', true, 26)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghijk', true, 25)).toBe(2)
    // Out of the keys, the placeholder cut to the field, at 23 and 22 columns.
    expect(fieldRowsOf('Answer', 'send', '', false, 19)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', '', false, 18)).toBe(2)
  })

  test('a field squeezed onto a second row in a narrow pane asks for that row', async ($, on) => {
    const { world, clock } = seat(on, earlier([{ ...XCODE_LONG, title: 'Paste the failures', why: "I can't run Xcode." }]))
    await start($)

    await runTasks($)
    // At 28 columns Claude Code 2.1.296 squeezes `⏎ send` under the empty field: 13 rows in all.
    const ui = await $.ui.mount(inline(24))
    await ui.press({ key: 'answer' })
    expect(world.opens.at(-1)?.rows).toBe(13)

    // A short answer leaves the hint room on its row.
    await ui.input({ key: 'answer-2', text: 'abc', kind: 'change' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)

    await ui.input({ key: 'answer-2', text: 'abcdefghijk', kind: 'change' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(13)
  })

  test('an empty field in a narrow pane, hidden and opened again, takes the ring and asks for the row it squeezes onto', async ($, on) => {
    const { world, clock } = seat(on, earlier([{ ...XCODE_LONG, title: 'Paste the failures', why: "I can't run Xcode." }]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(24))
    await ui.press({ key: 'answer' })
    // Out of the keys, the field draws no hint: one row.
    await $.ui.focus(ringTo('long'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)

    // Hidden and opened again, the field's autoFocus takes the ring, and `⏎ send` squeezes under it.
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    await $.ui.mount(inline(24))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(13)
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

  test('the phone, which draws no field, offers Done and a Reject that rejects at once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })

    expect((await phone.findAll({ type: 'Button' })).map(button => button.props.label)).toEqual(['Done', 'Reject', 'Hide'])

    await phone.press({ key: 'reject' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      "My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures: I won't do this.",
    ])
  })

  test('a field open on a surface that draws one leaves the task its buttons on the phone', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })

    expect(await ui.find({ type: 'Input' })).toBeDefined()
    expect((await phone.findAll({ type: 'Button' })).map(button => button.props.label)).toEqual(['Done', 'Reject', 'Hide'])
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

/** A second task that takes an answer, as XCODE_TASK does. */
const ANDROID_TASK = { ...XCODE_TASK, title: 'Run the Android tests on your phone, paste the failures' } as const

/** The pane's focus ring moving onto `element`, as the person's click or Tab moves it. */
function ringTo(element: string) {
  return {
    component: 'Pane',
    requestId: 'my-tasks',
    plugin: 'human-in-the-loop',
    element,
    origin: { kind: 'person' },
  } as const
}

describe('the answer field', () => {
  test("Answer… opens a field of the task's own, labelled for the terminal to add its colon", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.label).toBe('Answer')
  })

  test("a draft stays with its task: another task's field opens empty, and the first keeps its own", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-2' }))?.props.value).toBe('')

    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('LoginTests.testExpiredToken failed')
  })

  test('a held answer comes back to its field on Edit', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED, kind: 'change' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await ui.press({ key: 'edit' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe(KEY_SHAPED)
  })

  test('typed in, the field keeps the value it opened with: one drawn anew puts its text back, keys typed since lost', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests', kind: 'change' })
    // The pane draws again while the user types: Claude assigns another task.
    await $.tool.call(ANDROID_TASK)

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('hidden and opened again, the field holds what was typed in it', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    const again = await $.ui.mount(PANE)

    expect((await again.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test("hidden and opened again while the engine can't list its panes, the field holds what was typed in it", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await ui.press({ key: 'hide' })
    await ui.unmount()
    world.isPanesFailing = true
    await runTasks($)
    const again = await $.ui.mount(PANE)

    expect((await again.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test('with no draft to draw again, the pane opens without asking which panes are open', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await runTasks($)

    expect(world.opens).toHaveLength(2)
    expect(world.panesAsked).toBe(0)
  })

  test('a client attaching draws the field with what is typed in it, and leaves a field drawn elsewhere the value it opened with', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })
    const laptop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // The pane draws again: Claude assigns another task.
    await $.tool.call(ANDROID_TASK)

    expect((await laptop.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('a second client of a surface draws the field with what is typed in it', async ($, on) => {
    const { clock } = seat(on)
    await start($)
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })

    await $.tool.call(XCODE_TASK)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'answer' })
    await desktop.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    // The desktop app opens on another computer, and draws the pane.
    await $.session.attach({ surface: 'desktop', clientId: 'office' })
    await desktop.redraw()

    expect((await desktop.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test('typed in, the field asks for the rows its text wraps to, and for one row less once the keys leave it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    // The field takes the keys as it opens.
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0

    // 45 columns for the text beside `Answer: ` and ` ⏎ send`, one kept for the cursor: three rows.
    await ui.input({
      key: 'answer-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // Out of the keys, the text is cut to one row; the label, squeezed, wraps onto a second.
    await ui.redraw({ ...inline(60).props, isFocused: false })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Back in them, the ring is where it was.
    await ui.redraw(inline(60).props)
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // Tab moves the keys on, and Shift+Tab brings them back.
    await $.ui.focus(ringTo('other-way'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    await $.ui.focus(ringTo('answer-1'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('the ring taken by the field unseen, as the pane opens again or a key is typed there, the field asks for the rows its text wraps to', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({
      key: 'answer-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await $.ui.focus(ringTo('long'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Hidden and opened again, the field's autoFocus takes the ring.
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    const again = await $.ui.mount(inline(60))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // A key typed in the field says the ring is there.
    await $.ui.focus(ringTo('long'))
    await clock.settle()
    await again.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with rounding', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('opened again, a field takes the ring and asks for the rows its draft wraps to', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({
      key: 'answer-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await $.ui.focus(ringTo('other-way'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'answer' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('a key typed as a move of the ring re-sizes the pane, the pane asks for the rows the key leaves', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'answer' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Tab moves the keys on, and that re-size reads slowly once it has the
    // draft; the person comes back to the field and types meanwhile.
    world.slowRead = 'isWorking'
    world.readMs = 100
    await $.ui.focus(ringTo('other-way'))
    await clock.settle()
    const typing = ui.input({
      key: 'answer-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await clock.settle()
    await clock.advance(100)
    await typing
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('a placeholder longer than the field is cut to its row', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(32))
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter sends it t…')
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
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter saves it; Claude gets it when this turn ends')
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.appended).toHaveLength(0)
    expect(await textOf(ui, 'saved-1')).toContain('not sent yet')
    // The pane has the room to say what is not sent; the status line says it short.
    expect(await textOf(ui, 'head')).toContain('✓ 1 response not sent yet')
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
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter saves it; Claude gets it with your other answers')
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
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
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.refusingTyped = 'Blocked by your organization.'
    const blocked = await $.prompt.submit(typed('now the cart'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    // The engine shows why the prompt didn't enter; the answer waits, as it did.
    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.refusingTyped = undefined
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a saved answer that a hook beneath takes out of a typed prompt waits for the next one, and a toast says so', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isStripping = true
    const stripped = await $.prompt.submit(typed('now the cart'))

    expect(stripped.context).toBeUndefined()
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.isStripping = false
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test('a saved answer a hook beneath takes out of a typed prompt that quotes its head still waits for the next one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isStripping = true
    const stripped = await $.prompt.submit(typed('Earlier you wrote "#1 done: Run xcodebuild test on your Mac, paste the failures." Why?'))

    expect(stripped.context).toBeUndefined()
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')
  })

  test('a saved answer that a hook beneath rewrites as it rides a typed prompt reaches Claude', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed with token abc123' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.rewriting = text => text.replace('abc123', '******')
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed with token ******')
    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('of two saved answers riding a typed prompt, the one a hook beneath takes out waits for the next', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await ui.press({ key: 'option-1' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // A hook beneath cuts #2's line out of what rides along.
    world.rewriting = text => text.split('\n').filter(line => !line.startsWith('#2 ')).join('\n')
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
    expect(next.context?.[0]).not.toContain('#2 ')
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #2: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.rewriting = undefined
    const again = await $.prompt.submit(typed('and the docs'))

    expect(again.context?.[0]).toContain('#2 done: Pick a pagination strategy for /feed. The user chose: Cursor')
    expect(again.context?.[0]).not.toContain('LoginTests.testExpiredToken failed')
  })

  test('a response a hook beneath takes out of the message that wakes Claude waits for Send now: the turn that message starts ends without sending it again', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // A hook beneath masks the key's name in every prompt, the plugin's own among them.
    world.masking = text => text.replaceAll('STRIPE_SECRET_KEY', '*****')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")

    // The turn that message starts ends, and another after it.
    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: '', turnId })
      await $.turn.complete({ ...DONE, turnId })
      await clock.settle()
    }

    expect(world.submitted).toHaveLength(1)
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    world.masking = undefined
    await ui.press({ key: 'send-1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.status).toBeUndefined()
  })

  test('a typed prompt that fails beneath keeps its own error, and its answer waits, though the store fails too', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isTypedFailing = true
    world.isStoreFailing = true
    await expect($.prompt.submit(typed('now the cart'))).rejects.toThrow('no implementation for prompt.submit')

    expect(world.toasts.at(-1)).toContain("Claude didn't get your response to #1: no implementation for prompt.submit")
    expect(world.toasts.at(-1)).toContain("It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.isTypedFailing = false
    world.isStoreFailing = false
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test("of two saved responses, the first row's Send now answers s and the other a click", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await ui.press({ key: 'option-1' })

    expect((await ui.find({ type: 'Button', key: 'send-1' }))?.props.hotkey).toBe('s')
    expect((await ui.find({ type: 'Button', key: 'send-2' }))?.props.hotkey).toBeUndefined()
  })

  test('Send now while Claude works reaches it in the turn', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
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

  test('a prompt typed while Send now joins the turn carries no second copy of the answer', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)

    // The row takes a moment to join the conversation, and the user types meanwhile.
    world.appendMs = 500
    await ui.press({ key: 'send-1' })
    await clock.settle()
    const typedMeanwhile = await $.prompt.submit(typed('and the cart', 't1'))
    await clock.advance(500)

    expect(typedMeanwhile.context).toBeUndefined()
    expect(world.appended.filter(row => row.type === 'user')).toHaveLength(1)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('Send now that the running turn refuses goes the moment the turn ends', async ($, on) => {
    const { world, clock } = seat(on)
    world.refusingRows = 'No conversation to append to.'
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
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

  test('Send now that the running turn refuses as it ends goes at once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })

    // The row is refused a moment after it goes, and the turn ends meanwhile.
    world.refusingRows = 'No conversation to append to.'
    world.appendMs = 500
    await ui.press({ key: 'other-way' })
    await clock.advance(800)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(500)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('CartTests.testCouponRounding')
    expect(world.status).toBeUndefined()
  })

  test('Send now pressed twice at once sends the answer once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)

    await Promise.all([ui.press({ key: 'send-1' }), ui.press({ key: 'send-1' })])
    await clock.settle()

    expect(world.appended.filter(row => row.type === 'user')).toHaveLength(1)
  })

  test('a choice and a rejection reach Claude together', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'option-1' })
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'reason-2', text: 'I will do it after the deploy' })
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
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
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
    await ui.input({ key: 'answer-1', text: 'Two failures' })

    const listed = await $.tool.call({ tool: LIST })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
    expect(world.isPaneOpen).toBe(false)
  })

  test('list_tasks for one task marks only that one heard', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await ui.press({ key: 'option-1' })

    expect(world.status).toBe('✓ 2 not sent yet · /my-tasks')

    const listed = await $.tool.call({ tool: LIST, id: 1 })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')
  })

  test('a response that comes in while list_tasks reads is not marked heard: it goes later', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    // list_tasks reads the task list late: Done on #2 lands meanwhile, and
    // its write of #1 heard reads the list again.
    world.slowRead = 'tasks'
    world.readMs = 500
    const listed = $.tool.call({ tool: LIST })
    await clock.advance(1)
    await ui.press({ key: 'done' })
    await clock.advance(500)
    const result = String(((await listed) as { result?: unknown }).result)

    expect(result).toContain('Two failures')
    expect(result).toContain('#2 open')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#2 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('a withdraw that meets an answer given a moment before leaves the answer, and Claude hears it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    // The withdraw reads the task list late: Done lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found the key in the vault' })
    await clock.advance(1)
    await ui.press({ key: 'done' })
    await clock.advance(500)

    expect(((await withdrawn) as { deny?: string }).deny).toBe('Task #1 is already done; there is nothing to withdraw.')
    expect(world.toasts).toEqual([])

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('a press from a render older than a withdraw leaves the task withdrawn, and a toast says so', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    // Done reads the task list late: Claude withdraws #1 meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'done' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    await pressed
    await clock.settle()

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('Save for later with nothing typed asks for an answer, or, pressed as Claude withdraws its task, says the task is gone', async ($, on) => {
    const { world } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'other-way' })

    expect(world.toasts.at(-1)).toBe('Type an answer first, or press Cancel.')

    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
  })

  test('Save for later pressed as Claude withdraws its task puts what was typed in the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    // Save for later reaches its button as Claude withdraws the task, the
    // draft gone with it, before the drawing that withdraw wakes.
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box.")
    expect(world.composer).toBe('LoginTests.testExpiredToken failed')
  })

  test('Long answer… pressed as Claude withdraws its task says the task is gone, and puts what was typed in the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'long' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box.")
    expect(world.composer).toBe('LoginTests.testExpiredToken failed')
  })

  test('a title pressed as Claude withdraws its task leaves the field open on another task', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-2', text: 'Pixel 8 passes', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'select-1' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(await ui.find({ type: 'Input', key: 'answer-2' })).toBeDefined()
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures')
  })

  test('Save for later pressed as the same answer lands from the prompt box says nothing, as a second press does', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.prompt.submit(typed('↳ Answer to #1: Two failures'))
    held.letGo()
    await pressed

    expect(world.toasts).toEqual([])
    expect(world.composer).toBe('')
  })

  test('an answer held for looking like a secret, entered as Claude withdraws its task, says the task is gone', async ($, on) => {
    const { world } = seat(on)
    // Held, an input reaches its field once the test lets it go.
    let isHeld = false
    let letGo = () => {}
    on('ui.input', async ($, e, next) => {
      if (isHeld) {
        isHeld = false
        await new Promise<void>(resolve => {
          letGo = resolve
        })
      }

      return next(e)
    })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    isHeld = true
    const entered = ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    letGo()
    await entered

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.composer).toBe('')
  })

  test('a task withdrawn as the user types for it takes the drafts along, and leaves the prompt box as the user has it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'reason-1', text: 'Not on this Mac', kind: 'change' })
    await clock.settle()
    world.composer = 'Also bump the version'
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found it in the CI logs' })

    expect(world.composer).toBe('Also bump the version')
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures. Found it in the CI logs')
  })

  test("of two presses from one render, the response that lands first stands, and a toast says the other wasn't saved", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    // Offset reads the task list late: Cursor lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'option-2' })
    await clock.advance(1)
    await ui.press({ key: 'option-1' })
    await clock.advance(500)
    await pressed
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Pick a pagination strategy for /feed: I chose "Cursor".'])
    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved."])
  })

  test('the same press twice from one render answers once, says nothing, and holds back no batch under way', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    const ui = await $.ui.mount(PANE)
    // The first press reads the task list late: the second lands meanwhile, and the batch starts.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'option-1' })
    await clock.advance(1)
    world.ops = []
    await ui.press({ key: 'option-1' })
    await clock.advance(500)
    await pressed

    // The press that found it answered changed nothing, so wrote nothing.
    expect(world.ops).toEqual([`set ${keysOf('/repo').session('session-1')}`])

    await clock.advance(300)

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Pick a pagination strategy for /feed: I chose "Cursor".'])
    expect(world.toasts).toEqual([])
  })

  test("an answer typed for a task answered meanwhile on another surface isn't saved: a toast says so, and it goes to the prompt box", async ($, on) => {
    const { world, clock } = seat(on)
    world.composer = 'and check the cart'
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    // The answer reads the task list late: Done on the phone lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const answered = ui.input({ key: 'answer-1', text: 'Two failures' })
    await clock.advance(1)
    await phone.press({ key: 'done' })
    await clock.advance(500)
    await answered
    await clock.advance(1000)

    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box."])
    expect(world.composer).toBe('and check the cart\nTwo failures')
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures: Done.'])
  })

  test('an answer held for looking like a secret, sent anyway as its task is answered elsewhere, stays out of the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await clock.settle()
    // Send anyway reads the task list late: Done on the phone lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const sent = ui.press({ key: 'send-anyway' })
    await clock.advance(1)
    await phone.press({ key: 'done' })
    await clock.advance(500)
    await sent

    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved."])
    expect(world.composer).toBe('')
  })

  test('Send now repeating an answer saved for later a moment before sends it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    // Send now reads the task list late: Enter saves the same answer meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'other-way' })
    await clock.advance(1)
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.appended.map(row => row.type)).toEqual(['user', 'system'])
    expect(world.appended[0]?.text).toContain('Two failures')
    expect(world.toasts).toEqual([])
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

  test('a draft goes with Long answer… into the prompt box, and the field opens empty after', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken', kind: 'change' })
    await ui.press({ key: 'long' })

    expect(world.composer).toBe('↳ Answer to #1: LoginTests.testExpiredToken')

    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('typed while Claude is idle and dropped by a hook beneath, the answer is kept to send', async ($, on) => {
    const { world } = seat(on)
    world.refusingTyped = 'Blocked by your organization.'
    await start($)

    await $.tool.call(XCODE_TASK)
    const blocked = await $.prompt.submit(typed('↳ Answer to #1: Two failures'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    // The engine shows why; the toast says the answer is kept.
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')
  })

  test('typed while Claude is idle and a response is about to go, the prompt carries both', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    // Done goes in a moment, with whatever else is pressed by then.
    await ui.press({ key: 'done' })
    world.setMs = 1000
    const sending = $.prompt.submit(typed('↳ Answer to #2: Two failures'))
    await clock.advance(3000)
    const sent = await sending
    await clock.settle()

    expect(sent.text).toContain('#1 Add STRIPE_SECRET_KEY to .env: Done.')
    expect(sent.text).toContain('#2 Run xcodebuild test on your Mac, paste the failures:\nTwo failures')
    expect(world.submitted).toEqual([])
  })

  test('typed while Claude is idle as Send now takes the same answer, it goes once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    world.setMs = 1000
    const sending = $.prompt.submit(typed('↳ Answer to #2: Two failures'))
    await clock.settle()
    await ui.press({ key: 'send-2' })
    await clock.advance(3000)
    const sent = await sending
    await clock.settle()

    expect(sent.drop).toBe('Your answer to #2 already went to Claude.')
    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#2 Run xcodebuild test on your Mac, paste the failures:\nTwo failures',
    ])
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

  test('typed while Claude works, an answer to a task Claude withdraws meanwhile goes as typed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    // The prompt reads the task list late: Claude withdraws #1 meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const sending = $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    const sent = await sending
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(sent.drop).toBeUndefined()
    expect(sent.text).toBe('↳ Answer to #1: Two failures')
    expect(sent.context).toBeUndefined()
    expect(world.submitted).toEqual([])
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
  const MINE = KEYS.session('session-1')

  /** This version's slots, by session id. */
  function slotsIn(store: Record<string, unknown>) {
    return projectOf('/repo', store).slots
  }

  /** A task as a note of what was taken names it. */
  function refOf(task: { id: number; createdMs: number }) {
    return { id: task.id, createdMs: task.createdMs }
  }

  test("the first store layout's open tasks come back in the next session, and Claude is told", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 8,
        tasks: [
          null,
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
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
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

    // 0.1.4's value keeps its live session's slot as it wrote it, its count raised past #8, which
    // that session numbers from; this session's slot has a key of its own.
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000 } }, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([8])
    expect(slotsIn(world.store)['session-1']?.nextId).toBe(9)
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
    expect(slotsIn(world.store)['session-0']).toEqual({ tasks: [answered], seenMs: NOW + 30_000 })
    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
  })

  test("an ended 0.1.4 session's tasks, and a quiet one's, are taken on by the next session", async ($, on) => {
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

    // The quiet one may come back (a laptop asleep), on 0.1.4: its value notes what it lets go of then.
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: {}, taken: { 'session-x': { ids: [8], atMs: NOW } } })
    expect(slotsIn(world.store)['session-1']?.took).toEqual({
      'session-0': { tasks: [refOf(ROTATE)], atMs: NOW, isEnded: true },
      'session-x': { tasks: [{ id: 8, createdMs: 0 }], atMs: NOW },
    })
  })

  test("an ended session's slot leaves once the next session's is written; a quiet one's stays until it comes back", async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
      [KEYS.session('session-x')]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 9 },
    })
    await start($)

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-x'])
    expect(slotsIn(world.store)['session-1']?.took).toEqual({
      'session-0': { tasks: [refOf(ROTATE)], atMs: NOW, isEnded: true },
      'session-x': { tasks: [refOf(quiet)], atMs: NOW },
    })

    // The quiet one comes back and lets its task go: the notes have done their work.
    world.store[KEYS.session('session-x')] = { tasks: [], seenMs: NOW + 30_000, nextId: 9 }
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.took).toBeUndefined()
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
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

  test('a slot its session writes again after this one read it stays', async ($, on) => {
    const { world } = seat(on, { [KEYS.session('session-x')]: { tasks: [], seenMs: NOW - 10 * 60_000, nextId: 9 } })
    // Session x comes back as this session writes its slot, before x's empty one is removed.
    world.landing = () => {
      world.store[KEYS.session('session-x')] = { tasks: [], seenMs: NOW, nextId: 9 }
    }
    await start($)

    expect(world.landing).toBeUndefined()
    expect(slotsIn(world.store)['session-x']).toEqual({ tasks: [], seenMs: NOW, nextId: 9 })
  })

  test('a store that fails as the session starts: the heartbeat takes the project on once it answers, with what was assigned meanwhile', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    expect(world.status).toBeUndefined()

    // Numbered without the project's count, which the store didn't give.
    const assigned = await $.tool.call(KEY_TASK)
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1, 7])
    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
  })

  test('a session that reads the project late keeps the tasks it was done with, and no task it takes on gets their numbers', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [{ ...ROTATE, id: 2 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 3 },
    })
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.tool.call({ tool: WITHDRAW, id: 2, reason: 'Ran it in CI' })
    await $.tool.call({ tool: WITHDRAW, id: 3, reason: 'Went with cursor' })
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    for (const [id, title] of [[2, XCODE_TASK.title], [3, PAGING_TASK.title], [4, ROTATE.title]] as const) {
      const listed = await $.tool.call({ tool: LIST, id })
      expect(String((listed as { result?: unknown }).result)).toContain(title)
    }
  })

  test('a store that fails as the session starts: once the heartbeat reads the project, the pane opens for what it took on', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(world.opens.at(-1)?.focus).toBeUndefined()
  })


  test('a store that fails as the session starts, then refuses writes: once the heartbeat reads the project, the pane opens for what it took on', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    world.isStoreFailing = false
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-0'])

    // The next heartbeat makes the writes, and the slot it took the task from leaves.
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([ROTATE])
  })

  test('a resumed session keeps its notes of what it took', async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }
    const note = { tasks: [refOf(quiet)], atMs: NOW - 10 * 60_000 }
    const { world } = seat(on, {
      [KEYS.session('session-x')]: { tasks: [quiet], seenMs: NOW - 20 * 60_000, nextId: 9 },
      [MINE]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 9, took: { 'session-x': note } },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.took).toEqual({ 'session-x': note })
  })

  test('a session that took a slot on and stopped before removing it leaves nothing to take on twice', async ($, on) => {
    const { world } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
      // Session 9 took session 0's task on, and stopped before it removed session 0's slot.
      [KEYS.session('session-9')]: {
        tasks: [ROTATE],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-0': { tasks: [refOf(ROTATE)], atMs: NOW - 10 * 60_000, isEnded: true } },
      },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-9'])
  })

  test('a session resumed after it ended takes its task back from a quiet session that had taken it, and keeps it', async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    // Session t took #7 on as this session ended, removed its slot, and went quiet.
    const { world, clock } = seat(on, {
      [KEYS.session('session-t')]: {
        tasks: [mine],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-1': { tasks: [refOf(mine)], atMs: NOW - 50 * 60_000, isEnded: true } },
      },
    })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([7])
  })

  test('a session that takes its task back keeps it, though the write that notes it fails', async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    const { world, clock } = seat(on, {
      [KEYS.session('session-t')]: {
        tasks: [mine],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-1': { tasks: [refOf(mine)], atMs: NOW - 50 * 60_000, isEnded: true } },
      },
    })
    world.isWriteFailing = true
    await start($)
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.took?.['session-t']?.tasks).toEqual([refOf(mine)])
  })

  test('a session whose task was taken back while it was away lets it go, and its note of taking it with it', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-r' }
    const { world, clock } = seat(on, { [KEYS.session('session-r')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    await start($)

    // Asleep: session r, resumed, took #7 back.
    world.isStoreFailing = true
    await clock.advance(240_000)
    await clock.settle()
    world.isStoreFailing = false
    world.store[KEYS.session('session-r')] = {
      tasks: [held],
      seenMs: NOW + 240_000,
      nextId: 8,
      took: { 'session-1': { tasks: [refOf(held)], atMs: NOW + 230_000 } },
    }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #7 while this one was away. Answer it there.')
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 300_000, nextId: 8 })
    expect(world.status).toBe('1 task in another session')

    // Session r drops its note once this slot has let #7 go: #7 is still its own.
    world.store[KEYS.session('session-r')] = { tasks: [held], seenMs: NOW + 330_000, nextId: 8 }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('1 task in another session')
  })

  test('a resumed session whose task was taken back while it was gone holds nothing, and notes nothing as it joins', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-r' }
    // This session took #7 on from session r, went quiet, and r, resumed, took it back.
    const { world } = seat(on, {
      [MINE]: { tasks: [held], seenMs: NOW - 20 * 60_000, nextId: 8, took: { 'session-r': { tasks: [refOf(held)], atMs: NOW - 30 * 60_000 } } },
      [KEYS.session('session-r')]: { tasks: [held], seenMs: NOW, nextId: 8, took: { 'session-1': { tasks: [refOf(held)], atMs: NOW - 10 * 60_000 } } },
    })
    await start($)

    expect(world.status).toBe('1 task in another session')
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 8 })
  })

  test('a resumed session that holds nothing marks its slot alive as it joins, its count in it', async ($, on) => {
    const { world } = seat(on, {
      [MINE]: { tasks: [], seenMs: NOW - 10 * 60_000, nextId: 8, endedMs: NOW - 10 * 60_000 },
    })
    await start($)

    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 8 })
  })

  test("a 0.1.4 session's end counts at once, however recently it wrote", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000, endedMs: NOW - 10_000 } }, taken: {} },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
  })

  test("a session 0.1.4 kept takes its slot out of 0.1.4's value, resumed or hot reloaded", async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    const legacy = { nextId: 8, sessions: { 'session-1': { tasks: [mine], seenMs: NOW - 30_000 } }, taken: {} }
    const { world } = seat(on, { 'tasks:/repo': legacy })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([mine])

    // Reloaded from 0.1.4, whose last write put its slot back.
    world.store['tasks:/repo'] = legacy
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([mine])
  })

  /** The store as session 2 leaves it on taking on session 1's tasks (those of `ids`, or all) while session 1 slept. */
  function takeOn(store: Record<string, unknown>, ids?: readonly number[]) {
    const mine = (slotsIn(store)['session-1']?.tasks ?? []).filter(task => ids === undefined || ids.includes(task.id))

    store[KEYS.session('session-2')] = {
      tasks: mine,
      seenMs: NOW,
      nextId: Math.max(...mine.map(task => task.id)) + 1,
      took: { 'session-1': { tasks: mine.map(refOf), atMs: NOW } },
    }
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

    // Its slot stays, empty, to carry its count.
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 60_000, nextId: 3 })
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1, 2])
  })

  test('a task assigned on waking keeps its place, the ones taken on elsewhere go', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    const assigned = await $.tool.call(XCODE_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #2')
    expect(String((assigned as { result?: unknown }).result)).toContain('Open tasks: 1 of 5.')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([2])
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
  })

  test('an assignment Claude already made, on waking, still lets go of what was taken and redraws', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    takeOn(world.store, [2])
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    // Nothing was assigned, and the slot no longer holds what was let go.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
  })

  test('a heartbeat that lets tasks go redraws, though its write fails', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // Session 2 took #2 on, and has ended since: nothing in another session to count.
    takeOn(world.store, [2])
    world.store[KEYS.session('session-2')] = { ...(world.store[KEYS.session('session-2')] as object), endedMs: NOW }
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a press while a heartbeat lets tasks go is kept', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    takeOn(world.store, [2])
    // The heartbeat reads the task list late as it lets #2 go, after reading
    // it once for its own slot: Done on #1 lands meanwhile.
    world.slowRead = 'tasks'
    world.fastReads = 1
    world.readMs = 500
    await clock.advance(60_000)
    const pressed = ui.press({ key: 'done' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts).toContain('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBe('1 task in another session')
  })

  test('Claude withdrawing, on waking, a task another session took on meanwhile is told it is gone', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false

    const withdrawn = await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found it in the vault' })

    expect((withdrawn as { deny?: string }).deny).toBe('No task #1.')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
  })

  test('assigning on waking reads the project once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false
    world.ops = []
    await $.tool.call(XCODE_TASK)

    expect(world.ops).toEqual(['keys', `get ${MINE}`, `set ${MINE}`])
  })

  test('a pane press waking the session after two heartbeats lets go of what was taken first', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    // Asleep: no heartbeat has written the slot since.
    world.isStoreFailing = true
    await clock.advance(120_000)
    await clock.settle()
    world.isStoreFailing = false

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts.some(toast => toast.includes('took on task #1 while this one was away'))).toBe(true)
    expect(world.submitted).toHaveLength(0)
  })

  test('a prompt typed on waking carries no answer to a task another session took on meanwhile', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // Asleep: session 2 took both on, the saved answer with them.
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false

    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('Another session in this project took on tasks #1, #2 while this one was away. Answer them there.')
    expect(world.status).toBe('2 tasks in another session')
  })

  test('an answer typed during a turn, on waking, to a task another session took on meanwhile goes as typed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    // Asleep: session 2 took the task on.
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false
    await $.turn.start({ text: 'go', turnId: 't1' })

    const sent = await $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))

    expect(sent.text).toBe('↳ Answer to #1: Two failures')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
  })

  test('the heartbeat keeps the slot alive and counts tasks other sessions take on', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW }
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
  })

  test('assigning reads the project and writes the slot once', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await $.tool.call(XCODE_TASK)

    expect(world.ops).toEqual(['keys', `get ${MINE}`, `set ${MINE}`])
  })

  test('a pane press or a prompt writes the slot and reads nothing', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    world.ops = []

    await ui.press({ key: 'done' })
    await $.prompt.submit(typed('now the cart'))
    await clock.advance(1000)
    await clock.settle()

    expect(world.ops.length).toBeGreaterThan(0)
    expect(world.ops.filter(op => op !== `set ${MINE}`)).toEqual([])
  })

  test('a session that never held a task leaves no slot, though it reads the project', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await clock.advance(2 * 60_000)
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    expect(world.ops.filter(op => op === 'keys')).toHaveLength(3)
    expect(world.ops.filter(op => op.startsWith('set '))).toEqual([])
  })

  test('an ending session leaves its tasks for the next in one write, and after /clear takes them on again', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    // No read: the exit's budget is short.
    expect(world.ops).toEqual([`set ${MINE}`])
    expect(slotsIn(world.store)['session-1']?.endedMs).toBe(NOW)

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
  })

  test('after an in-process resume the session joins the project again, taking on what the one it left had', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])

    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-3']?.seenMs).toBe(NOW + 60_000)
    expect(slotsIn(world.store)['session-3']?.endedMs).toBeUndefined()
  })

  test('an ending session goes on without its write when the store is stuck', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)

    expect(await ending).toEqual({ sessionId: 'session-1' })
  })

  /** Ends session 1 with /clear while the store is stuck: session 2 waits to join until it answers. */
  async function clearStuck($: Engine, { world, clock }: ReturnType<typeof seat>) {
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-2'
    const cleared = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)
    await cleared
    await clock.settle()
  }

  test("a response held for Send now holds back no other task's by its number", async ($, on) => {
    const done = { ...ROTATE, state: 'done', update: 'pending', answer: 'Rotated.' } as const
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [{ ...done, updatedMs: 5 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    // A hook beneath takes the vault's name out of a typed prompt's digest: #7 waits for Send now.
    world.masking = text => text.replaceAll('Vault', '*****')
    await $.prompt.submit(typed('next'))
    world.masking = undefined
    await (await $.ui.mount(PANE)).press({ key: 'send-7' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)

    // Another session's #7, answered there before it ended, comes to the session after /clear, and goes as a turn ends.
    world.store[KEYS.session('session-9')] = {
      tasks: [{ ...done, sessionId: 'session-9', updatedMs: 9 }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 8,
    }
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    await $.turn.start({ text: 'next', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.submitted[1]).toContain('#7 Rotate the leaked token in Vault')
  })

  /** Session x drew #1 at the same moment as this one, and ended: the session after /clear takes it on as #1. */
  async function clearTakingOnAnotherOne($: Engine, { world, clock }: ReturnType<typeof seat>) {
    world.store[KEYS.session('session-x')] = {
      tasks: [{ ...ROTATE, id: 1, sessionId: 'session-x' }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 2,
    }
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
  }

  test('a task that comes back after /clear under the number of one Claude withdrew takes nothing typed for that one, open or closed', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clearTakingOnAnotherOne($, seated)

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => [task.id, task.title])).toEqual([
      [1, ROTATE.title],
      [2, ANDROID_TASK.title],
    ])

    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'other-way' })
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Type an answer first, or press Cancel.')
    expect(slotsIn(world.store)['session-2']?.tasks.find(task => task.id === 1)?.state).toBe('open')
    expect(world.composer).toBe('')

    // Withdrawn as Save for later is pressed again, with nothing typed for it.
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.composer).toBe('')
  })

  test("keys that reach a field as Claude withdraws its task leave nothing for a task back under its number after /clear, and the session's own drafts stay", async ($, on) => {
    const seated = seat(on)
    // Held, an input reaches its field once the test lets it go.
    let isHeld = false
    let letGo = () => {}
    on('ui.input', async ($, e, next) => {
      if (isHeld) {
        isHeld = false
        await new Promise<void>(resolve => {
          letGo = resolve
        })
      }

      return next(e)
    })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-2', text: 'Pixel 8 passes', kind: 'change' })
    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })
    // A key reaches #1's field as Claude withdraws the task, before the drawing that withdraw wakes.
    isHeld = true
    const entered = ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    letGo()
    await entered
    await clearTakingOnAnotherOne($, seated)
    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')

    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-2' }))?.props.value).toBe('Pixel 8 passes')
  })

  for (const [label, key, field] of [
    ['Answer…', 'answer', 'answer-1'],
    ['Reject…', 'reject', 'reason-1'],
  ] as const) {
    test(`${label} pressed as Claude withdraws its task neither selects nor opens a field on a task back under its number after /clear`, async ($, on) => {
      const seated = seat(on)
      const held = holdingPresses(on)
      await start($)

      await $.tool.call(XCODE_TASK)
      await $.tool.call(ANDROID_TASK)
      const ui = await $.ui.mount(PANE)
      held.isOn = true
      const pressed = ui.press({ key })
      await $.tool.call({ tool: WITHDRAW, id: 1 })
      held.letGo()
      await pressed
      await clearTakingOnAnotherOne($, seated)

      // #2 stays the one selected, its why drawn, and the task back under #1 stays shut.
      expect(await textOf(ui, 'task-2')).toContain(XCODE_TASK.why)
      expect(await textOf(ui, 'task-1')).not.toContain(ROTATE.why)
      expect(await ui.find({ type: 'Input', key: field })).toBeUndefined()
    })
  }

  test('Answer… that reads its task open just before Claude withdraws it leaves no field for a task back under its number after /clear', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    // The press reads the tasks late, as they stood before the withdraw.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'answer' })
    await clock.settle()
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    await pressed
    await clearTakingOnAnotherOne($, seated)

    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()
  })

  test("a task the join after a resume in place numbers anew, as the resumed session's own task keeps the number, keeps its field, its draft and the ring", async ($, on) => {
    const { world, clock } = seat(on)
    const failures = 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error'
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: failures, kind: 'change' })
    await clock.settle()
    // Session 0 drew #1 at the same moment as this one, and ended; this one resumes it in place.
    world.store[KEYS.session('session-0')] = { tasks: [{ ...ROTATE, id: 1, sessionId: 'session-0' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
    world.sessionId = 'session-0'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-0' } })
    await clock.advance(1)
    await clock.settle()

    // The Xcode task is #3 now, still selected, its field open with the draft; session 0's own task keeps #1.
    expect(await textOf(ui, 'task-3')).toContain(XCODE_TASK.title)
    expect((await ui.find({ type: 'Input', key: 'answer-3' }))?.props.value).toBe(failures)
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()

    // The ring went along: moved onto the field, it leaves the rows as they are.
    const rows = world.opens.at(-1)?.rows
    await $.ui.focus(ringTo('answer-3'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows)
  })

  test("after /clear the tasks the process holds keep their numbers and the open field, though another session's slot holding one of them comes first", async ($, on) => {
    // Session x's slot is first in the store.
    const seated = seat(on, { [KEYS.session('session-x')]: { tasks: [], seenMs: NOW, nextId: 1 } })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await seated.clock.settle()
    await clearTakingOnAnotherOne($, seated)

    // Session x's task is #3 now, and the Xcode task, still #1, stays selected.
    expect(await textOf(ui, 'task-3')).toContain(ROTATE.title)
    expect(await textOf(ui, 'task-3')).not.toContain(ROTATE.why)
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()

    // Claude withdrawing #1 withdraws the Xcode task.
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    expect(seated.world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures')
  })

  test('a session that ends after /clear before its join has begun ends all the same and takes nothing quiet', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Session 2 ends before the clock runs its join.
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })
    world.store[KEYS.session('session-q')] = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    await clock.advance(1)
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
    expect(slotsIn(world.store)['session-2']?.endedMs).toBe(NOW)
    // No heartbeat, and no pane opened unasked, for a session that has ended.
    expect(world.opens).toHaveLength(1)
    world.ops = []
    await clock.advance(60_000)
    await clock.settle()
    expect(world.ops).toEqual([])
  })

  test("a session resumed into another folder acts on none of the tasks it leaves, and assigns none, until it has read the new folder", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    // A response saved while Claude works, not sent yet.
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    await (await $.ui.mount(PANE)).press({ key: 'done' })
    await clock.advance(1000)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    await clock.settle()

    const isRefused = async () => String(((await $.tool.call(XCODE_TASK)) as { deny?: string }).deny).includes('still joining its project')
    expect(await isRefused()).toBe(true)
    expect(((await $.tool.call({ tool: LIST })) as { deny?: string }).deny).toContain('still joining its project')
    expect((await $.prompt.context({ blocks: [] })).blocks).toHaveLength(0)
    expect((await $.prompt.submit(typed('hello'))).context).toBeUndefined()
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()
    expect(world.submitted).toHaveLength(0)

    // The store answers, and the new folder's first read is slow: still nothing until it is in.
    world.isStuck = true
    world.unstick?.()
    await clock.settle()
    expect(await isRefused()).toBe(true)

    world.unstick?.()
    await clock.settle()
    const assigned = await $.tool.call(XCODE_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(world.submitted).toHaveLength(0)
    // The response waits in the folder it was given in, for the next session there.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.update)).toEqual(['pending'])
  })

  test('a session resumed into another folder and straight back acts on none of that folder\'s tasks as it moves back', async ($, on) => {
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    world.sessionId = 'session-4'
    world.root = '/repo'
    const back = $.session.end({ reason: 'resume', sessionId: 'session-3', resume: { id: 'session-4' } })
    await clock.advance(10_000)
    await back

    // The store answers, its writes slow: Claude lists its tasks as the queue drains.
    world.setMs = 1000
    world.unstick?.()
    const listed: string[] = []

    for (let i = 0; i < 100; i++) {
      await clock.advance(100)
      const result = (await $.tool.call({ tool: LIST, show: 'all' })) as { result?: unknown; deny?: string }
      listed.push(String(result.result ?? result.deny))
    }

    expect(listed.some(one => one.includes(ROTATE.title))).toBe(false)
    expect(listed.at(-1)).toContain(KEY_TASK.title)
  })

  test("a response held for Send now holds back nothing of the folder the session resumes into", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.masking = text => text.replaceAll('STRIPE_SECRET_KEY', '*****')
    await (await $.ui.mount(PANE)).press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    world.masking = undefined
    // An answer the session that ended in the other folder never sent, with
    // the number and the time of the response held here.
    const updatedMs = slotsIn(world.store)['session-1']?.tasks[0]?.updatedMs
    world.store[keysOf('/other').session('session-0')] = {
      tasks: [{ ...ROTATE, id: 1, state: 'done', update: 'pending', updatedMs }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 2,
    }
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.submitted[1]).toContain(ROTATE.title)
  })

  test('a session that ends after /clear before it has joined, the store stuck, ends all the same and takes nothing quiet', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(KEY_TASK)
    await clearStuck($, seated)
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })
    await clock.advance(10_000)
    await ending

    // A session gone quiet meanwhile keeps its task: the next live session takes it on.
    world.store[KEYS.session('session-q')] = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    world.unstick?.()
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
    expect(slotsIn(world.store)['session-2']?.endedMs).toBe(NOW + 70_000)
  })

  test("a task assigned after /clear before the session has joined, the store stuck, is the new session's", async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(KEY_TASK)
    await clearStuck($, seated)
    await $.tool.call(XCODE_TASK)

    const ui = await $.ui.mount(PANE)
    const context = async () => (await $.prompt.context({ blocks: [] })).blocks.at(-1)?.text
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(await textOf(ui, 'task-2')).not.toContain('from an earlier session')
    expect(await context()).toContain('#2 open: Run xcodebuild')

    world.unstick?.()
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.sessionId)).toEqual(['session-1', 'session-2'])
    expect(await textOf(ui, 'task-2')).not.toContain('from an earlier session')
    expect(await context()).toContain('#1 open (from an earlier session)')
    expect(await context()).toContain('#2 open: Run xcodebuild')
  })

  test('a store that stops answering holds up a tool call a few seconds, and nothing after it', async ($, on) => {
    // A 0.1.4 session alive here: assigning raises 0.1.4's count too.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 1, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)

    let isWithdrawn = false
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 8 }).then(result => {
      isWithdrawn = true
      return result
    })
    await clock.advance(4000)
    expect(isWithdrawn).toBe(false)
    await clock.advance(1000)
    expect(String(((await withdrawn) as { result?: unknown }).result)).toContain('Withdrew task #8')

    const assigned = await $.tool.call(XCODE_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
  })

  test('a store that stops answering is asked nothing more until it answers', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read doesn't come back; the heartbeats after it ask nothing.
    world.isStuck = true
    await clock.advance(5 * 60_000)
    world.ops = []
    world.unstick?.()
    await clock.settle()

    expect(world.ops.filter(op => op === 'keys')).toEqual([])

    await clock.advance(60_000)
    await clock.settle()

    expect(world.ops.filter(op => op === 'keys')).toEqual(['keys'])
  })

  test('a store stuck as the session starts holds the start up a few seconds, and what it takes on shows once it answers', async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    world.isStuck = true

    let isStarted = false
    void start($).then(() => {
      isStarted = true
    })
    await clock.advance(4000)
    expect(isStarted).toBe(false)
    await clock.advance(1000)
    await clock.settle()
    expect(isStarted).toBe(true)
    expect(world.status).toBeUndefined()

    world.unstick?.()
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
  })


  test('a pane slow to open holds up neither the heartbeat nor the store', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    // The heartbeat takes the project on, and the pane it opens takes half a minute.
    world.isStoreFailing = false
    world.openMs = 30_000
    await clock.advance(66_000)
    world.openMs = 0
    const reads = world.ops.filter(op => op === 'keys').length
    await $.tool.call(KEY_TASK)

    // Assigning reads the project first, as it does with no pane opening.
    expect(world.ops.filter(op => op === 'keys').length).toBe(reads + 1)
  })


  test('a pane slow to open as the session starts holds up neither the heartbeat nor the store', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.openMs = 30_000
    const started = start($)
    await clock.advance(6_000)
    await started
    world.openMs = 0
    const reads = world.ops.filter(op => op === 'keys').length
    await $.tool.call(KEY_TASK)

    expect(world.ops.filter(op => op === 'keys').length).toBe(reads + 1)
  })

  test('after /clear whose end write failed, the session it becomes still takes on the tasks', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    world.isWriteFailing = true
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isWriteFailing = false
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear whose first read failed, the session it becomes takes the tasks on once the store answers, and only once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a session resumed in place while the store fails writes nothing until it reads the project, and keeps its own tasks', async ($, on) => {
    const own = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-3' }
    // Session 3, resumed below, last wrote a minute ago.
    const { world, clock } = seat(on, { [KEYS.session('session-3')]: { tasks: [own], seenMs: NOW - 60_000, nextId: 9 } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    // Done on the task it holds, before it has read the project.
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(slotsIn(world.store)['session-3']?.tasks).toEqual([own])

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])
    expect(slotsIn(world.store)['session-3']?.tasks).toEqual([own])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a session that ends before it could read the project hands on what it holds', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })

    // The next session finds nothing open: the answer went to Claude.
    expect(Object.values(slotsIn(world.store)).flatMap(slot => slot.tasks)).toEqual([])
  })

  test('a session that reads the project only as it ends takes nothing from a quiet session, which may come back', async ($, on) => {
    const quiet = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    const { world } = seat(on, { [KEYS.session('session-q')]: quiet })
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.isStoreFailing = false
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    expect(slotsIn(world.store)['session-q']).toEqual(quiet)
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.title)).toEqual([KEY_TASK.title])
    expect(slotsIn(world.store)['session-1']?.took).toBeUndefined()
  })

  test('after /clear, a press while the session it becomes takes the tasks on is kept', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Taking the tasks on, the new session reads its task list late: Done lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    await clock.advance(1)
    const pressed = ui.press({ key: 'done' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBeUndefined()
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.tasks).toEqual([])
  })

  test('after two /clears, the first never reading the project, the third session takes the tasks on once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'clear', sessionId: 'session-2', resume: { id: 'session-2' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])
    expect(slotsIn(world.store)['session-3']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear in a session that never read the project, the session it becomes takes on what it assigned', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear in a session that never read the project, one resumed elsewhere meanwhile keeps its slot', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    // Session 1, resumed in another terminal, wrote its slot; what this process assigned as session 1 it never saw.
    const resumed = { tasks: [{ ...ROTATE, sessionId: 'session-1' }], seenMs: NOW, nextId: 8 }
    world.store[MINE] = resumed
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    expect(slotsIn(world.store)['session-1']).toEqual(resumed)
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.title)).toEqual([KEY_TASK.title])
  })

  test('after /clear in a session that never read the project, one resumed elsewhere that went quiet keeps its slot to come back to', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    // Session 1, resumed in another terminal, wrote its slot and went quiet there: a laptop lid closed on it, say.
    const quiet = { tasks: [{ ...ROTATE, sessionId: 'session-1' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    world.store[MINE] = quiet
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1, 7])
    const note = slotsIn(world.store)['session-2']?.took?.['session-1']
    expect(note?.tasks.map(ref => ref.id)).toEqual([7])
    expect(note?.isEnded).toBeUndefined()

    // Its note stays until it comes back and lets the tasks go.
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']).toEqual(quiet)
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']).toEqual(note)
  })

  test('a session resumed into another folder takes on nothing the process held for this one', async ($, on) => {
    // Quiet session q's task, which this session takes on, noting it.
    const quiet = { ...ROTATE, sessionId: 'session-q' }
    const { world, clock } = seat(on, { [KEYS.session('session-q')]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 8 } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-2', resume: { id: 'session-3' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBeUndefined()
    expect(projectOf('/other', world.store).slots).toEqual({})
    // The next session here takes them on.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([7, 8])
  })

  test("a session resumed into another folder while the store fails shows nothing of this folder's", async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW } })
    await start($)

    await $.tool.call(KEY_TASK)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')

    world.sessionId = 'session-3'
    world.root = '/other'
    world.isStoreFailing = true
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBeUndefined()
    expect(world.isPaneOpen).toBe(false)

    // Numbered as a new process there would number it, without either project's count.
    const assigned = await $.tool.call(XCODE_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
  })

  test('a session resumed into another folder leaves behind the answer it was typing for this one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    // Typed, not sent.
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    const assigned = await $.tool.call({ ...XCODE_TASK, title: 'Run the Android tests on your phone, paste the failures' })
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')

    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()
    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })



  test('a session resumed into another folder as a turn ends wakes Claude for no answer the first one sent', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.appended.map(row => row.text)).toContain('Sent your response to #1 to Claude')
    expect(world.submitted).toEqual([])
  })

  test('a session resumed into another folder selects there as a new session would', async ($, on) => {
    const migration = { ...ROTATE, id: 2, title: 'Approve the staging migration', why: 'It drops a column.' }
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-0')]: {
        tasks: [{ ...ROTATE, id: 1 }, migration],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 3,
      },
    })
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(await textOf(ui, 'task-1')).toContain(ROTATE.why)
    expect(await textOf(ui, 'task-2')).not.toContain(migration.why)
  })


  test('a session resumed into another folder takes on the slot there of the session it left', async ($, on) => {
    // Session 1 ran in the other folder once, and ended there holding a task.
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-1')]: {
        tasks: [{ ...ROTATE, sessionId: 'session-1' }],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 8,
      },
    })
    await start($)

    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(projectOf('/other', world.store).slots)).toEqual(['session-3'])
  })

  test("a session resumed into another folder changes nothing of 0.1.4's there before it reads that project", async ($, on) => {
    // A 0.1.4 session alive in this folder.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    world.sessionId = 'session-3'
    world.root = '/other'
    world.isStoreFailing = true
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false
    // Assigning, the session reads the project, and the store fails just then.
    world.failing = 1
    await $.tool.call(KEY_TASK)

    expect(world.ops).toContain('keys')
    expect(Object.keys(world.store)).toEqual(['tasks:/repo'])
  })


  test("after /clear, the session it becomes changes nothing of 0.1.4's before it reads the project", async ($, on) => {
    // A 0.1.4 session alive in this folder.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    const legacy = JSON.parse(JSON.stringify(world.store['tasks:/repo'])) as unknown
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Its reads of the project fail: as it joins, and as it assigns.
    world.failing = 1
    await clock.advance(1)
    world.failing = 1
    await $.tool.call(XCODE_TASK)

    expect(world.store['tasks:/repo']).toEqual(legacy)
  })

  test('a slot that leaves after a month hands its own notes on, so nothing it took is taken twice', async ($, on) => {
    const DAY = 24 * 60 * 60_000
    const held = { ...ROTATE, sessionId: 'session-b' }
    // Session a took #7 on from quiet session b, and went quiet holding it; this one took it on from a.
    const { world, clock } = seat(on, {
      [KEYS.session('session-b')]: { tasks: [held], seenMs: NOW - 34 * DAY, nextId: 8 },
      [KEYS.session('session-a')]: {
        tasks: [held],
        seenMs: NOW - 32 * DAY,
        nextId: 8,
        took: { 'session-b': { tasks: [refOf(held)], atMs: NOW - 33 * DAY } },
      },
      [MINE]: { tasks: [held], seenMs: NOW - 31 * DAY, nextId: 8, took: { 'session-a': { tasks: [refOf(held)], atMs: NOW - 31 * DAY } } },
    })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-b'])
    expect(slotsIn(world.store)['session-1']?.took?.['session-b']).toEqual({ tasks: [refOf(held)], atMs: NOW - 33 * DAY })

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a slot that leaves as this session takes it on hands its own notes on, so nothing it took is taken twice', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-q' }
    const note = { tasks: [refOf(held)], atMs: NOW - 5 * 60_000 }
    // Session x took #7 on from quiet session q, and ended holding it.
    const { world, clock } = seat(on, {
      [KEYS.session('session-q')]: { tasks: [held], seenMs: NOW - 10 * 60_000, nextId: 8 },
      [KEYS.session('session-x')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8, took: { 'session-q': note } },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-q'])
    expect(slotsIn(world.store)['session-1']?.took?.['session-q']).toEqual(note)

    // After /clear, the session it becomes takes this one's task on, and not q's again.
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([7])
  })

  test("a slot or a note in 0.1.4's value that isn't one is skipped", async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-y' }
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 9,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': { seenMs: NOW },
          'session-y': { tasks: [quiet], seenMs: NOW - 10 * 60_000 },
        },
        taken: { 'session-y': { atMs: NOW - 60_000 } },
      },
    })
    await start($)

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: {}, taken: { 'session-y': { ids: [8], atMs: NOW } } })

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
  })

  test("what in a slot isn't a task, a count or a note is skipped", async ($, on) => {
    const elsewhere = { ...ROTATE, id: 5, title: 'Approve the staging migration', sessionId: 'session-z' }
    const { world } = seat(on, {
      [KEYS.session('session-0')]: {
        tasks: [ROTATE, null, { id: 9 }],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 'ten',
        took: { 'session-x': {}, 'session-z': { tasks: [null], atMs: NOW - 60_000 } },
      },
      [KEYS.session('session-z')]: { tasks: [elsewhere], seenMs: NOW, nextId: 6 },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-z'])
    expect((world.store[MINE] as { nextId?: unknown }).nextId).toBe(8)

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
  })

  test("a slot that leaves takes with it the copy of it 0.1.4's value kept", async ($, on) => {
    const answered = { ...ROTATE, id: 6, title: 'Approve the staging migration', sessionId: 'session-s' }
    const held = { ...ROTATE, sessionId: 'session-s' }
    // Session s came to this version from 0.1.4, and a 0.1.4 session's write put its slot back as it was then.
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-s': { tasks: [answered, held], seenMs: NOW - 60 * 60_000 } }, taken: {} },
      [KEYS.session('session-s')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
  })

  test("a slot left behind that leaves on the heartbeat takes 0.1.4's copy of it too", async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-s' }
    const left = { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    const { world, clock } = seat(on, { [KEYS.session('session-s')]: left })
    await start($)

    // The removal didn't stay, and a 0.1.4 session's write put back the copy its value had of session s.
    world.store[KEYS.session('session-s')] = left
    world.store['tasks:/repo'] = { nextId: 8, sessions: { 'session-s': { tasks: [held], seenMs: NOW - 60 * 60_000 } }, taken: {} }
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test("with a 0.1.4 session alive, a heartbeat reads its value once, and raises its count only when it fell back", async ($, on) => {
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await clock.advance(60_000)
    await clock.settle()

    expect(world.ops.filter(op => op === 'get tasks:/repo')).toEqual(['get tasks:/repo'])
    expect((world.store['tasks:/repo'] as { nextId: number }).nextId).toBe(9)

    // A 0.1.4 session's write puts back the count it read before.
    world.store['tasks:/repo'] = { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW + 60_000 } }, taken: {} }
    await clock.advance(60_000)
    await clock.settle()

    expect((world.store['tasks:/repo'] as { nextId: number }).nextId).toBe(9)
  })

  test("a slot of another folder whose key starts as this one's is not this project's", async ($, on) => {
    const other = keysOf('/repo#session:b').session('session-9')
    const { world } = seat(on, { [other]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    await start($)

    expect(world.status).toBeUndefined()
    expect(world.store[other]).toBeDefined()
  })

  test('a 0.1.4 note of tasks taken from this session leaves only once its slot has let them go', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // A 0.1.4 session took #2 on while this one slept.
    world.store['tasks:/repo'] = { nextId: 3, sessions: {}, taken: { 'session-1': { ids: [2], atMs: NOW } } }
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 3, sessions: {}, taken: {} })
  })


  test('a 0.1.4 note whose task the session let go of in a write that failed leaves only once the slot is written without it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // A 0.1.4 session took #2 on while this one slept; the heartbeat lets it go, and can't write.
    world.store['tasks:/repo'] = { nextId: 3, sessions: {}, taken: { 'session-1': { ids: [2], atMs: NOW } } }
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()
    world.isWriteFailing = false
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 3, sessions: {}, taken: {} })
  })

  test('a 0.1.4 note of tasks taken from this session, put back after it was read, takes nothing this session took on', async ($, on) => {
    // A 0.1.4 session took this one's #3 on while it slept, and an ended session left a #3 of its own.
    const legacy = { nextId: 4, sessions: {}, taken: { 'session-1': { ids: [3], atMs: NOW - 60_000 } } }
    const { world, clock } = seat(on, {
      'tasks:/repo': legacy,
      [KEYS.session('session-0')]: { tasks: [{ ...ROTATE, id: 3 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 4 },
    })
    await start($)

    expect((world.store['tasks:/repo'] as { taken: unknown }).taken).toEqual({})

    // A 0.1.4 session's write, from what it read before, puts the note back.
    world.store['tasks:/repo'] = legacy
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.title)).toEqual([ROTATE.title])
    expect(world.toasts).toHaveLength(0)
  })

  test('the count never goes back: a slot carries it once its tasks are gone, and the next session once it ends', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    for (const title of ['Approve the release', 'Rotate the key', 'Pick a name']) {
      await $.tool.call({ ...KEY_TASK, title })
    }

    for (const id of [1, 2, 3]) {
      await $.tool.call({ tool: WITHDRAW, id })
    }

    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 4 })

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    // The empty slot left once the next session's carried the count.
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #4')
  })

  test('the count of a session whose writes failed while it held a task reaches the store once it answers', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    world.isWriteFailing = true
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 60_000, nextId: 2 })
  })

  test("an ended slot that carries only its count keeps the numbers going, and leaves once this one's carries it", async ($, on) => {
    const { world } = seat(on, { [KEYS.session('session-0')]: { tasks: [], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 4 } })
    await start($)

    const assigned = await $.tool.call(KEY_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #4')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.nextId).toBe(5)
  })

  test('a project root too long for the store keys its slots by a hash', async ($, on) => {
    const { world } = seat(on)
    world.root = `/${'deep/'.repeat(42)}repo`
    world.sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    await start($)

    await $.tool.call(KEY_TASK)

    expect(Object.keys(world.store)).toEqual([keysOf(world.root).session(world.sessionId)])
    expect(Object.keys(world.store)[0]!.length).toBeLessThanOrEqual(256)
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
    await ui.input({ key: 'answer-3', text: '@acme/stripe-hooks' })
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
  test("a teammate's turn leaves Claude idle", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    // Main's turn is over; a teammate is still at work in its own.
    await $.turn.start({ text: 'review the diff', turnId: 'mate', agentId: 'reviewer' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
  })

  test("a subagent's turn ending leaves Claude at work in its own", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.start({ text: 'find the flaky test', turnId: 'sub', agentId: 'explorer' })
    await $.turn.complete({ ...DONE, turnId: 'sub', agentId: 'explorer' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
  })
})
