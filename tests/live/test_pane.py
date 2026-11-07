"""The My tasks pane as a real Claude Code draws it, at narrow and wide widths.

Run with `python3 tests/live/test_pane.py` from the repository's root, with
`claude` and `tmux` on the PATH. Each case seeds tasks an ended session left,
opens /my-tasks in a terminal of the given size and reads the screen back:
every title shows whole, nothing is cut off at the pane's bottom, and the
pane asks for no rows it leaves empty. Below 110 columns the pane is framed
above the prompt; from 110 it docks beside the transcript, about 88 columns
at most. With RENDERS_DIR set, each screen a test reads is kept there, and
`tests/live/renders.py` lays them out.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from screen import Claude, pane_body, placement  # noqa: E402

ROOT = os.environ.get('PLUGIN_DIR') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# Framed, then each side of where the pane docks (110), and past where the
# dock stops growing.
WIDTHS = (36, 48, 64, 100, 109, 110, 144, 200)
DOCK_FROM = 110
# Tall enough that the layout spares the pane every row it asks for.
HEIGHT = 90

INSTRUMENTS = 'Open Instruments from Xcode and record with the Activity Monitor template'
XCODE = 'Run xcodebuild test on your Mac and paste every failure you see here please'
GERMAN = 'Datenbankverbindungseinstellungsüberprüfungsprotokoll im Ordner ablegen'
JAPANESE = 'ステージング環境のデータベース移行を承認してください'
# Longer than a title may be assigned: an older version's, left in the store.
LONG = 'Rotate the deploy key ' + ' '.join(['and check every runner that holds it'] * 3)

TASKS = [
    {'id': 1, 'title': INSTRUMENTS, 'why': 'I need a trace of the launch to see where the 4 seconds go.', 'doneWhen': 'The .trace file is in ~/traces.'},
    {'id': 2, 'title': XCODE, 'why': "I can't run Xcode here.", 'kind': 'answer'},
    {'id': 3, 'title': GERMAN, 'why': 'Die Prüfung braucht es.'},
    {'id': 4, 'title': JAPANESE, 'why': 'The migration drops a column.', 'kind': 'choose', 'options': ['Approve', 'Wait for Monday']},
]

DAY_MS = 86_400_000

# Five tasks a day or more old, as a live session showed them on 0.1.4: the
# other tasks' ages fell into a column one character wide.
OLDER = [
    {'id': 6, 'title': 'Review and merge PR #1591 (alerts read access for release agents)', 'why': 'It documents how anyone, including an agent, reads prod alerts during a release. Merging it is your call.', 'doneWhen': 'PR #1591 is merged or closed.', 'ageMs': DAY_MS},
    {'id': 27, 'title': 'Update Slack Voice to 0.2.0 and retry /slack after a Claude Slack draft', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 28, 'title': 'Review the Mira in the Fiverr App plan, then share it', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 35, 'title': 'Review the supply-gaps method doc and draft workbook, then send to Shimon', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 36, 'title': 'Approve the staging migration', 'why': 'w', 'ageMs': 5 * DAY_MS},
]

SAVED = [
    {'id': 5, 'title': LONG, 'why': 'It leaked.', 'state': 'done', 'update': 'pending'},
]

# Emoji the terminal draws two cells wide, below U+1F300 too: the title wraps at 100 columns.
EMOJI = 'Tag issues ✅ done, ❌ failed, ⏳ waiting, ⚡ urgent, ⛔ blocked'

# An answer longer than its field's row, with a word longer than the row too.
DRAFT = 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding'


def unhinted(text):
    """Text with a field's hint gone: `⏎ send`, and `· \\⏎ new line` beside a field of several rows."""
    return re.sub(r'⏎ send( · (\\|shift\+)⏎ new line)?', '', text)


def flat(text):
    """Text as one line: the pane's wrapping and the frame's padding gone."""
    return re.sub(r'\s+', ' ', text).strip()


def joined(body):
    """The pane's body read as prose: its rows joined, the glyphs and indents gone."""
    return flat(' '.join(re.sub(r'^[☐✓✗]\s', '', row.strip()) for row in body))


class Pane(unittest.TestCase):
    def draw(self, tasks, columns, keys=()):
        claude = Claude(ROOT)
        try:
            claude.seed(tasks)
            # Text typed goes by `typed` in the name, a key by its own.
            name = '-'.join([self._testMethodName, str(columns), *('typed' if ' ' in key else key for key in keys)])
            screen = claude.pane(columns, HEIGHT, keys, name=name)
        finally:
            claude.close()
        body = pane_body(screen)
        context = f'at {columns} columns the pane drew {placement(screen)}:\n' + '\n'.join(body)
        self.assertEqual(placement(screen), 'dock' if columns >= DOCK_FROM else 'inline', context)
        return body, context

    def assert_fits(self, body, context):
        # The foot ends what is drawn, a blank row above it: none cut off
        # below it. Framed, it is the pane's last row, none asked for and
        # left empty; docked, the pane runs on to the screen's bottom.
        rows = [row.strip() for row in body]
        foot = max(i for i, row in enumerate(rows) if row)
        self.assertIn('Hide', rows[foot], 'the pane is cut off\n' + context)
        self.assertEqual(rows[foot - 1], '', context)
        self.assertNotEqual(rows[foot - 2], '', 'a row asked for and left empty\n' + context)

    def test_titles_wrap_whole_and_the_pane_fits_them(self):
        # As many tasks as fit the pane's 18 rows at each width.
        for columns, tasks in ((36, TASKS[:2]), (48, TASKS[:1] + TASKS[2:]), *((width, TASKS) for width in WIDTHS[2:])):
            with self.subTest(columns=columns):
                body, context = self.draw(tasks, columns)
                text = joined(body)

                self.assert_fits(body, context)
                self.assertIn(f'#1 {INSTRUMENTS} 3m · from an earlier session', text, context)
                self.assertIn('d: Done', text, context)
                self.assertIn('x: Reject…', text, context)

                if XCODE in [task['title'] for task in tasks]:
                    self.assertIn(f'#2 {XCODE} 3m · from an earlier session', text, context)

                if GERMAN in [task['title'] for task in tasks]:
                    # A word longer than the row breaks where the row ends, nothing lost.
                    self.assertIn(f'#3{GERMAN}3m·fromanearliersession'.replace(' ', ''), text.replace(' ', ''), context)
                    self.assertIn(f'#4{JAPANESE}3m·fromanearliersession', text.replace(' ', ''), context)

    def test_five_older_tasks_show_each_title_and_age_whole(self):
        body, context = self.draw(OLDER, 66)
        text = joined(body)

        self.assert_fits(body, context)
        self.assertIn(f"#6 {OLDER[0]['title']} 1d · from an earlier session", text, context)
        for task in OLDER[1:]:
            self.assertIn(f"#{task['id']} {task['title']} 5d · from an earlier session", text, context)

    def test_a_pane_taller_than_its_rows_scrolls_and_squeezes_nothing(self):
        body, context = self.draw(TASKS, 36)

        self.assertEqual(len(body), 18, context)
        # The rows in view are whole: none pressed into another.
        self.assertIn(f'#2 {XCODE} 3m · from an earlier session', joined(body), context)

    def test_the_age_never_wraps_into_a_column_of_its_own(self):
        for columns in WIDTHS:
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[:1], columns)
                rows = [row for row in body if row.strip() != '']
                # Each row of the title starts at the title's indent: the age flows after it.
                title_rows = rows[1 : 1 + next(i for i, row in enumerate(rows[1:]) if 'I need a trace' in row)]
                for row in title_rows[1:]:
                    self.assertTrue(row.startswith('  ') and not row.startswith('   '), 'a title row out of line\n' + context)
                self.assertIn('3m · from an earlier session', joined(title_rows), context)

    def test_emoji_take_the_cells_the_terminal_draws_them_in(self):
        for columns in (36, 100, 110, 200):
            with self.subTest(columns=columns):
                body, context = self.draw([{'id': 7, 'title': EMOJI, 'why': 'The ⌛ build waits on it.', 'kind': 'answer'}], columns)

                self.assert_fits(body, context)
                self.assertIn(f'#7 {EMOJI} 3m · from an earlier session', joined(body), context)

    def test_saved_responses_and_titles_past_80_characters_show_whole(self):
        for columns in (48, 64, 110):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2] + SAVED, columns)
                # Send now sits beside the title's first row.
                text = joined(body).replace(' s: Send now', '')

                self.assert_fits(body, context)
                self.assertIn(f'#5 {LONG} · not sent yet', text, context)
                self.assertIn('s: Send now', body[next(i for i, row in enumerate(body) if '#5' in row)], context)

    def test_an_open_answer_field_fits(self):
        for columns in (36, 64, 110, 200):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2], columns, keys=('r',))
                text = joined(body)

                self.assert_fits(body, context)
                # Across the body's whole width, which the terminal sizes a field by.
                self.assertTrue(any(row.startswith('Answer: ') for row in body), context)
                self.assertIn('Cancel', text, context)

    def test_answer_pressed_with_the_keys_hands_them_to_its_field(self):
        # Tab onto Answer… and Enter: the keys go to the field, not to the button drawn where Answer… was.
        body, context = self.draw(TASKS[1:2], 64, keys=('Tab', 'Tab', 'Enter', 'Two failures'))

        self.assertTrue(any(row.startswith('Answer: Two failures') for row in body), context)

    def test_a_long_answer_wraps_in_its_four_rows_and_the_pane_fits_them(self):
        # Typed after Answer…: the keys go to the field, not to the pane's hotkeys.
        for columns in (36, 64, 110, 200):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2], columns, keys=('r', DRAFT))
                text = unhinted(joined(body)).replace(' ', '')

                self.assert_fits(body, context)
                # Wrapped beside the label, the hint after its first row: whole
                # where four rows hold it, else scrolled to its end, where the cursor is.
                self.assertIn(DRAFT.replace(' ', '') if columns > 36 else 'CartTests.testCouponRounding', text, context)
                self.assertIn('Cancel', joined(body), context)

    def test_an_answer_of_two_lines_keeps_them_and_the_pane_fits(self):
        # A backslash and Enter start a new line, as the field's hint says.
        for columns in (36, 64, 110):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2], columns, keys=('r', 'LoginTests.testExpiredToken\\', 'Enter', 'CartTests.testCouponRounding'))
                rows = [unhinted(row).strip() for row in body]
                first = next(i for i, row in enumerate(rows) if row.startswith('Answer: '))

                field = ''.join(rows[first:]).replace(' ', '')

                self.assert_fits(body, context)
                # Enter took the backslash for a new line: the field is open still, the backslash gone.
                self.assertIn('Answer:LoginTests.testExpiredTokenCartTests.testCouponRounding', field, context)
                self.assertNotIn('\\', field, context)

    def test_closed_and_opened_again_the_field_holds_what_was_typed_in_it(self):
        # ctrl+x x closes the pane as the person's close key does, and the
        # terminal forgets the field's text; /my-tasks opens it again.
        body, context = self.draw(TASKS[1:2], 64, keys=('r', DRAFT, 'C-x', 'x', '/my-tasks', 'Enter'))

        self.assertIn(DRAFT.replace(' ', ''), unhinted(joined(body)).replace(' ', ''), context)

    def test_a_long_answer_out_of_the_keys_keeps_the_pane_fitted(self):
        # Tab moves the keys on: the field keeps its four rows, the text cut to them.
        for columns in (36, 64, 110):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2], columns, keys=('r', DRAFT, 'Tab'))

                self.assert_fits(body, context)
                self.assertIn('Cancel', joined(body), context)


class TranscriptRow(unittest.TestCase):
    def test_the_label_stays_whole_and_the_title_wraps_after_it(self):
        for columns in (40, 64):
            with self.subTest(columns=columns):
                claude = Claude(ROOT)
                try:
                    tool_input = {'title': XCODE, 'why': "I can't run Xcode here.", 'kind': 'answer'}
                    screen = claude.transcript(columns, 40, tool_input, name=f'{self._testMethodName}-{columns}')
                finally:
                    claude.close()
                lines = screen.split('\n')
                start = next(i for i, line in enumerate(lines) if '☐' in line)
                row = flat(' '.join(lines[start : start + 4]).split('───')[0])

                self.assertIn('☐ Assigned you a task: ', lines[start], screen)
                self.assertIn(f'☐ Assigned you a task: {XCODE}', row, screen)


if __name__ == '__main__':
    unittest.main(verbosity=2)
