"""Mind Map keeps native Cloze generation and isolated assets; fixtures use Anki HTML."""

import json
from html import escape
from html.parser import HTMLParser
import os
from pathlib import Path
import sys
import tempfile
import unittest

from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions, ImportAnkiPackageRequest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_package as package


def image(alt):
    # The project's own diagram is a media fixture, not course material.
    return f'<img src="_rule-build.svg" alt="{escape(alt)}" width="960" height="360">'


def chapter_cases():
    return {
        "comparison_chapter": '<p>章节总览 ' + image('宏观总览') + '</p>'
            '<ul><li>多分数比较<ul><li>找最值<ul>'
            '<li>目的<ul><li>{{c1::避免干扰项影响}}</li></ul></li>'
            '<li>最值标准<ul><li>最大值标准<ul>'
            '<li>{{c2::<b>分子尽量大、分母尽量小</b>}}</li>'
            '<li>例题 · 图片旁普通文字 {{c3::' + image('例题 & Example') + '}} / {{c3::解析示意}}'
            '<ul><li>子节点：保留图片的说明。</li></ul></li>'
            '</ul></li><li>最小值标准</li></ul></li>'
            '<li>排序题</li><li>插值分数比较</li></ul></li>'
            '<li>个人备注<ul><li>补充自己的联系。</li></ul></li></ul></li></ul>',
        "symmetry_chapter": '<ul><li>对称<ul><li>轴对称<ul>'
            '<li>特征：从宏观类别进入微观知识。</li>'
            '<li>典型图形 {{c1::' + image('典型图形') + '}}</li>'
            '<li>{{c2::Mixed 图片说明 ' + image('混合 & Mixed') + '::图片与说明}}'
            ' / {{c3::判断方法}}<ul><li>更深层解释</li></ul></li>'
            '</ul></li><li>中心对称<ul><li>{{c3::' + image('特征图') + '}}</li>'
            '<li>易错点：保留前后知识点。</li>'
            '<li>普通说明图 ' + image('普通图片') + '</li></ul></li></ul></li></ul>',
    }


class Elements(HTMLParser):
    """Read native output attributes, without interpreting Cloze source syntax."""
    def __init__(self, markup, tag):
        super().__init__()
        self.tag, self.attributes = tag, []
        self.feed(markup)

    def handle_starttag(self, tag, attrs):
        if tag == self.tag:
            self.attributes.append(dict(attrs))


class MindMapTests(unittest.TestCase):
    def test_native_cloze_and_browser_fixtures(self):
        spec = next(s for s in package.specifications() if s["key"] == "mindmap")
        cases = {
            "single": '<ul><li>{{c1::中文 English}}</li></ul>',
            "flat": '无列表 {{c1::<b>答案</b>::提示}}',
            "loose": '<p>Heading Needle {{c1::root}}</p><ul><li>Child {{c2::leaf}}</li></ul><p>Footer needle</p>',
            "wrapper": '<div>Intro Needle<ul><li>Needle {{c1::wrapped}}</li></ul>Footer</div>',
            "mixed": '<ul><li>Root<ul><li></li><li>中文 {{c1::<b>答案</b>::提示}} / {{c1::第二}}</li>'
                     '<li>Search Need<b>le</b> and needle<ul><li>{{c2::Hidden Needle}}</li></ul></li>'
                     '<li>Image <img src="_rule-build.svg" alt="示意图"></li>'
                     '<li>' + 'Long中英Text ' * 1000 + '</li></ul></li></ul>',
            "deep": '<ul><li>Level' * 80 + '{{c1::Deep answer}}' + '</li></ul>' * 80,
            "large": '<ul><li>Large tree<ul>' + ''.join(
                f'<li>Node {i} ' + ('{{c1::Answer ' + str(i) + '}}' if i % 20 == 0 else '中英 Mixed') + '</li>'
                for i in range(2000)) + '</ul></li></ul>',
            "formatting": '<ul><li><div>Wrapped parent<ul><li><p>{{c1::child}}</p>'
                          '<table><tr><td>wide</td><td>table</td></tr></table>'
                          '<pre>' + '0123456789' * 80 + '</pre></li></ul></div></li></ul>',
        }
        chapters = chapter_cases()
        cases.update(chapters)
        with tempfile.TemporaryDirectory() as d:
            collection = Collection(str(Path(d) / "collection.anki2"))
            try:
                model = package.make_model(collection, spec, 1)
                self.assertEqual(model["type"], 1)
                self.assertEqual([f["name"] for f in model["flds"]], ["标题", "内容"])
                self.assertNotIn('_review.js', model["tmpls"][0]["qfmt"])
                rendered = {}
                for name, content in cases.items():
                    note = collection.new_note(model)
                    note["标题"], note["内容"] = name, content
                    collection.add_note(note, collection.decks.id("Test"))
                    cards = note.cards()
                    count = 3 if name in chapters else 2 if name in ("mixed", "loose") else 1
                    self.assertEqual(len(cards), count)
                    self.assertIn('data-cloze=', cards[0].question())
                    self.assertIn('data-ordinal="1"', cards[0].answer())
                    rendered[name] = [{"front": c.question(), "back": c.answer()} for c in cards]
                mixed = rendered["mixed"][0]
                self.assertEqual(mixed["front"].count('class="cloze"'), 2)
                self.assertIn('class="cloze-inactive" data-ordinal="2"', mixed["front"])
                if os.environ.get("ANKI_RENDER_OUTPUT"):
                    path = Path(os.environ["ANKI_RENDER_OUTPUT"]).parent / "mindmap-cases.json"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(rendered, ensure_ascii=False), encoding="utf-8")
            finally:
                collection.close()

    def test_chapter_images_survive_native_export_import(self):
        spec = next(s for s in package.specifications() if s["key"] == "mindmap")
        chapters = chapter_cases()
        with tempfile.TemporaryDirectory() as d:
            source = Collection(str(Path(d) / "source.anki2"))
            try:
                model = package.make_model(source, spec, 1)
                deck_id = source.decks.id("Chapters")
                for title, content in chapters.items():
                    note = source.new_note(model)
                    note["标题"], note["内容"] = title, content
                    source.add_note(note, deck_id)
                media = (package.CARDS / "media/_rule-build.svg").read_bytes()
                source.media.write_data('_rule-build.svg', media)
                apkg = Path(d) / "chapters.apkg"
                source.export_anki_package(out_path=str(apkg), limit=deck_id,
                    options=ExportAnkiPackageOptions(with_media=True, legacy=True, with_scheduling=False))
                imported = Collection(str(Path(d) / "imported.anki2"))
                try:
                    imported.import_anki_package(ImportAnkiPackageRequest(package_path=str(apkg)))
                    self.assertEqual(imported.note_count(), 2)
                    self.assertEqual(len(imported.find_cards("")), 6)
                    self.assertEqual((Path(imported.media.dir()) / '_rule-build.svg').read_bytes(), media)
                    for nid in imported.find_notes(""):
                        note = imported.get_note(nid)
                        content = chapters[note["标题"]]
                        self.assertEqual(note["内容"], content)
                        images = Elements(content, 'img').attributes
                        for card in note.cards():
                            front, back = card.question(), card.answer()
                            for side in (front, back):
                                self.assertEqual(len(Elements(side, 'li').attributes),
                                                 len(Elements(content, 'li').attributes), 'each card retains the whole tree')
                            self.assertEqual(Elements(back, 'img').attributes, images)
                            active = [s for s in Elements(front, 'span').attributes if s.get('class') == 'cloze']
                            self.assertTrue(active)
                            hidden_images = []
                            for span in active:
                                self.assertEqual(span['data-ordinal'], str(card.ord + 1))
                                hidden_images.extend(Elements(span['data-cloze'], 'img').attributes)
                            for attrs in hidden_images:
                                self.assertIn(attrs, images, 'native data-cloze preserves all image attributes')
                            self.assertEqual(len(Elements(front, 'img').attributes), len(images) - len(hidden_images),
                                             'active images are encoded answers, not visible native front images')
                finally:
                    imported.close()
            finally:
                source.close()

    def test_assets_are_exclusive_to_mindmap(self):
        for spec in package.specifications():
            if spec["key"] != "mindmap":
                self.assertNotIn('css', spec)
                for side in ("front", "back"):
                    self.assertNotIn('_mindmap', package.read_source(spec[side]))
        script = package.read_source('media/_mindmap.js')
        for token in ('fetch(', 'XMLHttpRequest', 'MutationObserver', 'localStorage', 'console.'):
            self.assertNotIn(token, script)
        self.assertNotIn("document.addEventListener", script)
        self.assertNotIn("window.addEventListener", script)


if __name__ == "__main__":
    unittest.main()
