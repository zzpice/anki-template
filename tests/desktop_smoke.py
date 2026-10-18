"""Optional real aqt smoke check in an isolated temporary profile.

Install full aqt dependencies, build build/review.apkg, then run this script.
It never opens personal profiles, enables sync, or answers scheduled cards.
"""
from pathlib import Path
import json
import os
import sys
import tempfile
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
os.environ['ANKI_SINGLE_INSTANCE_KEY'] = 'anki-template-review-' + uuid.uuid4().hex
os.environ['ANKI_SOFTWAREOPENGL'] = '1'
os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = '--disable-gpu'

import aqt
from aqt import gui_hooks
from aqt.profiles import ProfileManager
from aqt.qt import QTimer
from aqt.theme import theme_manager, Theme
from anki.import_export_pb2 import ImportAnkiPackageRequest

# Preseed our own profile to avoid language, sync and first-run dialogs.
base = Path(tempfile.mkdtemp(prefix='desktop-review-', dir=ROOT / 'build'))
pm = ProfileManager(base)
pm.setupMeta()
pm.create('Template review')
pm.load('Template review')
pm.meta.update(firstRun=False, defaultLang='en_US', check_for_updates=False,
               check_for_addon_updates=False)
pm.set_theme(Theme.LIGHT)
pm.profile['autoSync'] = False
pm.save()
pm.db.close()

results = []
checks = []
step = 0
finished = False


def stop(error=None):
    global finished
    if finished:
        return
    finished = True
    if error:
        print('FAIL', error, flush=True)
    output = {'profile': str(base), 'results': results, 'error': error}
    (ROOT / 'build/desktop-results.json').write_text(
        json.dumps(output, ensure_ascii=False, indent=2))
    if error:
        aqt.mw.app.exit(1)
    else:
        aqt.mw.unloadProfileAndExit()


def advance():
    global step
    try:
        if step >= len(checks):
            print(f'Desktop QtWebEngine: {len(results)} front/back checks passed '
                  'in isolated profile', flush=True)
            stop()
            return
        cid, side, dark = checks[step]
        step += 1
        mw, reviewer = aqt.mw, aqt.mw.reviewer
        reviewer.card = mw.col.get_card(cid)
        reviewer.card.start_timer()
        if theme_manager.night_mode != dark:
            mw.pm.set_theme(Theme.DARK if dark else Theme.LIGHT)
            theme_manager.apply_style()
        if reviewer._reps is None:
            reviewer._initWeb()
        if side == 'front':
            reviewer._showQuestion()
        else:
            reviewer._showAnswer()
        QTimer.singleShot(250, lambda: poll(cid, side, dark, 0))
    except Exception:
        stop(traceback.format_exc())


def poll(cid, side, dark, attempt):
    expression = '''(() => {
      const sheet = document.querySelector('[data-review], [data-mindmap]');
      if (!sheet) return null;
      const io = document.querySelector('#image-occlusion-container');
      return {
        side: !!document.querySelector('#answer'),
        io: !io || getComputedStyle(io).visibility === 'visible',
        canvas: !io || !!document.querySelector('canvas').width,
        overflow: document.documentElement.scrollWidth > innerWidth,
        ready: sheet.dataset.ready || sheet.dataset.mmReady,
        type: sheet.dataset.review || 'mindmap',
        color: getComputedStyle(document.body).color,
        selected: document.querySelectorAll('.review-selected').length,
        correct: document.querySelectorAll('.is-correct').length
      };
    })()'''

    def received(value):
        try:
            if (not value or value['side'] != (side == 'back') or not value['io']
                    or not value['canvas'] or not value['ready']):
                if attempt > 80:
                    stop(f'Card {cid} {side} timed out: {value}')
                else:
                    QTimer.singleShot(100, lambda: poll(cid, side, dark, attempt + 1))
                return
            assert not value['overflow'], value
            if side == 'front' and value['type'] == 'choice':
                aqt.mw.reviewer.web.eval("document.querySelector('.review-choice input').click()")
            if side == 'back' and value['type'] == 'choice':
                assert value['selected'] == 1 and value['correct'] >= 1, value
            expected = 'rgb(237, 238, 238)' if dark else 'rgb(41, 40, 36)'
            assert value['color'] == expected, value
            results.append({'card': cid, 'side': side, 'dark': dark, **value})
            if len(results) in (2, 10, 20, 30, 38, 48):
                output = ROOT / 'build/desktop-screenshots'
                output.mkdir(exist_ok=True)
                aqt.mw.reviewer.web.grab().save(str(output / f'desktop-{len(results)}.png'))
            QTimer.singleShot(50, advance)
        except Exception:
            stop(traceback.format_exc())

    aqt.mw.reviewer.web.evalWithCallback(expression, received)


def start():
    try:
        mw = aqt.mw
        mw.col.import_anki_package(ImportAnkiPackageRequest(
            package_path=str(ROOT / 'build/review.apkg')))
        mw.col.models._clear_cache()
        for dark in (False, True):
            for cid in mw.col.find_cards(''):
                checks.extend([(cid, 'front', dark), (cid, 'back', dark)])
        mw.col.decks.select(mw.col.decks.id_for_name('Anki 模板 · 示例'))
        mw.reset()
        mw.resize(960, 880)
        mw.moveToState('review')
        QTimer.singleShot(1000, advance)
    except Exception:
        stop(traceback.format_exc())


gui_hooks.profile_did_open.append(lambda: QTimer.singleShot(1000, start))
app = aqt._run(['anki-template-desktop-test', '-b', str(base), '-p',
                'Template review', '-l', 'en_US', '--safemode'], exec=False)
if app is None:
    raise RuntimeError('Isolated app did not start')
QTimer.singleShot(90000, lambda: stop('Desktop smoke timeout'))
sys.exit(app.exec())
