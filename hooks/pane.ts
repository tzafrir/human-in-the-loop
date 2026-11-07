import type { Editing, Task } from '../types'
import { MAX_OPTION, MAX_WHY, isActive, waitingOf } from './tasks'
import { ago, cellsOf, clip, printable, rowsOf } from './text'

/**
 * The longest title the pane and the transcript draw. `assign_task` takes
 * titles of at most MAX_TITLE characters; this bounds what an older version
 * or another session left in the store, never a title assigned now.
 */
export const MAX_SHOWN_TITLE = 300

/** The columns between two buttons in a row of them. */
export const BUTTON_GAP = 3

/** The cells before a task's text: its glyph, `☐ `. */
const GLYPH_CELLS = 2

/** The answer field's height: a few lines of a log fit in the pane. */
export const ANSWER_ROWS = 4

/** The fewest columns the terminal gives a focused field's text, however narrow the pane. */
const MIN_FIELD_COLUMNS = 12

/**
 * What the My tasks pane draws from: the tasks, which is selected and which
 * field is open, and what each row's words depend on. The render hook and
 * `rowsFor` both read it, so the rows asked for are the rows drawn.
 */
export type PaneView = {
  shown: readonly Task[]
  selectedId: number | null
  editing: Editing | null
  /** The draft in the open field. */
  draft: string
  nowMs: number
  sessionId: string
  isWorking: boolean
  /** The surface draws a text field (the mobile app draws none yet). */
  canType: boolean
  isFocused: boolean
  /** The open field has the keys: the terminal wraps what is typed there. */
  isTyping: boolean
}

export function selectedOf(view: PaneView): Task | undefined {
  const active = view.shown.filter(isActive)

  return active.find(task => task.id === view.selectedId) ?? active[0]
}

/** The pane's head: `☐ 2 tasks for you · 1 not sent yet`, or `✓ 1 response not sent yet`. */
export function headlineOf(view: PaneView): { glyph: string; headline: string; note: string } {
  return waitingOf(view.shown, 'response')
}

/** A task's whole title, safe to draw. */
export function nameOf(task: Task): string {
  return printable(task.title, MAX_SHOWN_TITLE)
}

/** `#3 Rotate the token`: a task's number and its whole title. */
export function titleOf(task: Task): string {
  return `#${task.id} ${nameOf(task)}`
}

/** `  3m · from an earlier session`, drawn dim after an open task's title. */
export function ageOf(task: Task, view: Pick<PaneView, 'nowMs' | 'sessionId'>): string {
  const earlier = task.sessionId === view.sessionId ? '' : ' · from an earlier session'

  return `  ${ago(view.nowMs - task.createdMs)}${earlier}`
}

export function whyOf(task: Task): string {
  return printable(task.why, MAX_WHY)
}

export function doneWhenOf(task: Task): string | undefined {
  return task.doneWhen === undefined ? undefined : `Done when: ${printable(task.doneWhen, MAX_WHY)}`
}

/** A saved response's row: its task, and that it waits. */
export function savedOf(task: Task): string {
  return `${titleOf(task)} · not sent yet`
}

/** The selected task's buttons, as `hotkey` and `label`. */
export function actionsOf(task: Task, canType: boolean): { key: string; hotkey: string; label: string; option?: string }[] {
  const choices =
    task.kind === 'choose' && task.options !== undefined
      ? task.options.map((option, i) => ({ key: `option-${i + 1}`, hotkey: String(i + 1), label: printable(option, MAX_OPTION), option }))
      : [{ key: 'done', hotkey: 'd', label: 'Done' }]

  const typed = canType
    ? [
        { key: 'answer', hotkey: 'r', label: task.kind === 'choose' ? 'Other…' : 'Answer…' },
        { key: 'reject', hotkey: 'x', label: 'Reject…' },
      ]
    : [{ key: 'reject', hotkey: 'x', label: 'Reject' }]

  return [...choices, ...typed]
}

// The terminal draws a field's label as `Answer: `.
export const ANSWER_LABEL = 'Answer'
export const REASON_LABEL = 'Reason'
export const REASON_PLACEHOLDER = 'Optional; Enter rejects it'
export const HELD =
  'This looks like a secret. Claude and the transcript on disk would see it. Put it where it belongs and press Done instead.'

export function answerPlaceholderOf(view: PaneView): string {
  if (!view.isWorking) {
    return 'Enter sends it to Claude'
  }

  return view.shown.filter(isActive).length > 1
    ? 'Enter saves it; Claude gets it with your other answers'
    : 'Enter saves it; Claude gets it when this turn ends'
}

/** The answer field's buttons. */
export function answerButtonsOf(view: PaneView): string[] {
  return [view.isWorking ? 'Send now' : 'Save for later', 'Long answer…', 'Cancel']
}

/** The key of task `id`'s field: its own, so no other task's draft, or the focus, lands in it. */
export function fieldKeyOf(field: Pick<Editing, 'id' | 'field'>): string {
  return `${field.field}-${field.id}`
}

/** What Enter does in a field, drawn beside it while it has the keys. */
export function submitLabelOf(field: Editing['field'], view: Pick<PaneView, 'isWorking'>): string {
  return field === 'reason' ? 'reject' : view.isWorking ? 'save' : 'send'
}

/**
 * The columns the terminal gives a focused field's text: the pane's body,
 * `columns` across, less the label (`Answer: `) and the hint (` ⏎ send`).
 */
export function fieldColumnsOf(label: string, submitLabel: string, columns: number): number {
  return Math.max(MIN_FIELD_COLUMNS, columns - cellsOf(`${label}: `) - cellsOf(` ⏎ ${submitLabel}`))
}

/** A placeholder cut to one row of its field, focused or not. */
export function placeholderOf(text: string, label: string, submitLabel: string, columns: number): string {
  return clip(text, fieldColumnsOf(label, submitLabel, columns))
}

/**
 * Whether the terminal cuts a label `head` cells wide short, with `rest`
 * cells after it on a row `columns` across, and wraps it onto a second: a row
 * too narrow takes from the label and what follows it each its share of what
 * the row lacks, and rounds where the label ends.
 */
function isLabelCut(head: number, rest: number, columns: number): boolean {
  return Math.round((head * columns) / (head + rest)) < head
}

/**
 * The rows a field takes across the pane's body, `columns` wide, holding
 * `text`. A field `height` rows tall, from two, is a box that tall: the terminal
 * scrolls what is typed inside it, and clips it out of the keys. A field of
 * one row draws its label, the field and, while it has the keys, the hint
 * on one row, and the label, cut short, wraps onto a second, as does the
 * hint. Typed in, it wraps the text a column short of it, for the cursor;
 * else it cuts the text, or the placeholder, to one row.
 */
export function fieldRowsOf(label: string, submitLabel: string, text: string, isTyping: boolean, columns: number, height = 1): number {
  if (height > 1) {
    return height
  }

  const head = cellsOf(`${label}: `)
  const field = fieldColumnsOf(label, submitLabel, columns)

  if (!isTyping) {
    // The placeholder is cut to the field.
    return isLabelCut(head, text === '' ? field : cellsOf(text), columns) ? 2 : 1
  }

  const rows = text.split('\n').reduce((rows, line) => rows + rowsOf(line, field - 1), 0)
  // The placeholder cut to the field, or the text and the cursor.
  const drawn = text === '' ? field : cellsOf(text) + 1

  return Math.max(rows, isLabelCut(head, drawn + cellsOf(` ⏎ ${submitLabel}`), columns) ? 2 : 1)
}

/** The `i`th saved row's Send now: the first answers `s`. */
export function sendNowOf(i: number): { hotkey?: string; label: string } {
  return i === 0 ? { hotkey: 's', label: 'Send now' } : { label: 'Send now' }
}

/** The `i`th saved row's Send now as the terminal draws it: `s: Send now` on the first. */
export function sendLabelOf(i: number): string {
  const { hotkey, label } = sendNowOf(i)

  return hotkey === undefined ? label : `${hotkey}: ${label}`
}

export function hintOf(view: PaneView): string {
  return view.isFocused ? 'Esc: back to the prompt' : 'Click, or press ctrl+x tab to use the keys'
}

export const HIDE = 'Hide'

/** The rows a row of buttons takes in `columns`, wrapping between buttons. */
export function buttonRowsOf(labels: readonly string[], columns: number): number {
  let rows = 1
  let x = 0

  for (const label of labels) {
    const width = cellsOf(label)

    if (x > 0 && x + BUTTON_GAP + width > columns) {
      rows += 1
      x = width
    } else {
      x += (x > 0 ? BUTTON_GAP : 0) + width
    }
  }

  return rows
}

/**
 * The rows the My tasks pane's body takes at `columns` cells across, each
 * text wrapped as the pane draws it: the head, the selected task whole, a
 * row (or more, for a long title) for every other task, and the foot; at
 * most `max`.
 */
export function rowsFor(view: PaneView, columns: number, max: number): number {
  const width = Math.max(1, columns)
  const inner = Math.max(1, width - GLYPH_CELLS)
  const active = view.shown.filter(isActive)
  const saved = view.shown.filter(task => !isActive(task))
  const selected = selectedOf(view)
  const head = headlineOf(view)
  let rows = rowsOf(`${head.glyph}${head.headline}${head.note}`, width) + 1

  for (const task of active) {
    if (task !== selected) {
      // `#2` is the button that selects it; the title wraps beside it.
      rows += rowsOf(` ${nameOf(task)}${ageOf(task, view)}`, Math.max(1, inner - cellsOf(`#${task.id}`)))
      continue
    }

    rows += rowsOf(`${titleOf(task)}${ageOf(task, view)}`, inner)
    rows += rowsOf(whyOf(task), inner)
    const doneWhen = doneWhenOf(task)
    rows += doneWhen === undefined ? 0 : rowsOf(doneWhen, inner)
    rows += controlRowsOf(task, view, width, inner)
  }

  saved.forEach((task, i) => {
    rows += rowsOf(savedOf(task), Math.max(1, inner - 2 - cellsOf(sendLabelOf(i))))
  })

  rows += 1 + rowsOf(hintOf(view), Math.max(1, width - BUTTON_GAP - cellsOf(HIDE)))

  return Math.min(max, rows)
}

/** The rows under the selected task: its buttons, or its field across the body (`width`) and the buttons under it. */
function controlRowsOf(task: Task, view: PaneView, width: number, inner: number): number {
  const field = view.editing !== null && view.editing.id === task.id ? view.editing : null

  if (field === null || !view.canType) {
    return buttonRowsOf(
      actionsOf(task, view.canType).map(action => `${action.hotkey}: ${action.label}`),
      inner,
    )
  }

  if (field.held !== undefined) {
    return rowsOf(HELD, inner) + buttonRowsOf(['Edit', 'Send anyway'], inner)
  }

  const [label, buttons] = field.field === 'answer' ? [ANSWER_LABEL, answerButtonsOf(view)] : [REASON_LABEL, ['Cancel']]
  const height = field.field === 'answer' ? ANSWER_ROWS : 1

  return fieldRowsOf(label, submitLabelOf(field.field, view), view.draft, view.isTyping, width, height) + buttonRowsOf(buttons, inner)
}
