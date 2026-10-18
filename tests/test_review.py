"""Generate edge cases with the current official backend, never a Cloze parser."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from anki.collection import Collection

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_package as package


class ReviewTests(unittest.TestCase):
    def test_native_review_fixtures(self):
        cases = {}
        with tempfile.TemporaryDirectory() as temp:
            collection = Collection(str(Path(temp) / 'collection.anki2'))
            try:
                specs = {s['key']: s for s in package.specifications()}
                models = {key: package.make_model(collection, spec, 1800000000) for key, spec in specs.items()}
                definitions = [
                    ('recall_first', 'choice', {'问题': '先回忆配置入口，再展开选项。', '选项': '<b>Alpha</b>||Beta||Gamma', '答案': 'AC', '题型': '多选'}, ['先回忆', '固定顺序']),
                    ('storage', 'choice', {'问题': '存储失败时的乱序映射', '选项': 'Alpha||Beta||Gamma', '答案': 'B', '题型': '单选'}, []),
                    ('invalid_options', 'choice', {'问题': '无效选项', '选项': 'One||||Three', '答案': 'A'}, []),
                    ('progressive', 'cloze', {'正文': '<p>一组 {{c1::<b>甲 &amp; A</b>::提示}} 和 {{c1::<img src="_rule-build.svg" alt="图中答案">}}；另一组 {{c2::乙}}。</p>'}, ['逐项揭示']),
                    ('math_cloze', 'cloze', {'正文': r'{{c1::\(x^2\)}} 与 {{c2::<p>块级内容</p>}}'}, ['逐项揭示']),
                    ('nested', 'cloze', {'正文': '{{c1::外层 {{c2::内层}}}}'}, ['逐项揭示']),
                    ('rich', 'basic', {'问题': '<p dir="rtl">العربية עברית</p><p>日本語 <ruby>漢字<rt>かんじ</rt></ruby> · 中文 &amp; English</p><p><img src="_rule-build.svg" width="960" height="360" alt="本地横图"></p>', '答案': '<p>Math: \\(x^2 + y^2\\)</p><p><em>强调</em> <sup>上标</sup> <sub>下标</sub> [sound:review-test.mp3]</p><blockquote>引用与长段落。</blockquote><pre><code>' + 'x = 1234567890; ' * 30 + '</code></pre><table><tr><th>宽表格</th><th>列二</th><th>列三</th><th>列四</th></tr><tr><td>中文</td><td>English</td><td>123</td><td>456</td></tr></table>'}, []),
                    ('io_hide_one', 'occlusion', {'Occlusion': '{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=0}}<br>{{c2::image-occlusion:rect:left=.6:top=.1:width=.2:height=.2:oi=0}}', 'Image': '<img src="_rule-build.svg">'}, []),
                    ('io_group', 'occlusion', {'Occlusion': '{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2:oi=1}}<br>{{c1::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.1:oi=1}}<br>{{c2::image-occlusion:polygon:left=.1:top=.6:points=.1,.6 .3,.6 .2,.9:oi=1}}', 'Image': '<img src="_rule-build.svg">'}, []),
                ]
                for name, kind, fields, tags in definitions:
                    note = collection.new_note(models[kind])
                    for key, value in fields.items():
                        note[key] = value
                    note.tags = tags
                    collection.add_note(note, 1)
                    cards = note.cards()
                    self.assertEqual(len(cards), 2 if kind in ('cloze', 'occlusion') else 1)
                    cases[name] = [{'front': card.question(), 'back': card.answer()} for card in cards]
                    if kind == 'occlusion':
                        native = collection._backend.get_image_occlusion_note(note.id).note
                        self.assertTrue(all(o.shapes for o in native.occlusions))
                        self.assertEqual(native.occlude_inactive, name != 'io_hide_one')
                    if kind == 'basic':
                        self.assertIn('Math:', cards[0].answer())
                        self.assertEqual(len(cards[0].answer_av_tags()), 1)
                if os.environ.get('ANKI_RENDER_OUTPUT'):
                    target = Path(os.environ['ANKI_RENDER_OUTPUT']).parent / 'review-cases.json'
                    target.write_text(json.dumps(cases, ensure_ascii=False))
            finally:
                collection.close()


if __name__ == '__main__':
    unittest.main()
