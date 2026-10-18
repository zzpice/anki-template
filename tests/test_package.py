"""在临时集合中检查官方导入、媒体、排程、更新和真实预览一致性。"""

import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_package as package

TEST_PACKAGE = Path(os.environ.get("ANKI_TEST_PACKAGE", package.OUTPUT)).resolve()
TEST_PREVIEW = Path(os.environ.get("ANKI_TEST_PREVIEW", package.PREVIEW)).resolve()


class PackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def collection(self, name="collection", source=TEST_PACKAGE):
        collection = Collection(str(self.directory / (name + ".anki2")))
        self.addCleanup(collection.close)
        self.import_into(collection, source)
        return collection

    @staticmethod
    def import_into(collection, path):
        collection.import_anki_package(ImportAnkiPackageRequest(package_path=str(path.resolve())))
        collection.models._clear_cache()

    def check_collection(self, collection):
        self.assertEqual(collection.note_count(), len(package.samples()))
        preview = json.loads(TEST_PREVIEW.read_text())
        self.assertEqual(len(collection.find_cards("")), sum(len(example["cards"]) for example in preview))
        self.assertEqual([s["name"] for s in package.specifications()], ["问答", "选择", "填空", "图片遮挡", "思维导图"])
        self.assertIsNotNone(collection.decks.id_for_name(package.DECK_NAME))
        for spec in package.specifications():
            model = collection.models.get(spec["id"])
            self.assertEqual(model["name"], spec["name"])
            self.assertEqual([f["name"] for f in model["flds"]], spec["fields"])
            expected_css = package.read_source("style.css")
            if spec.get("css"):
                expected_css += "\n" + package.read_source(spec["css"])
            self.assertEqual(model["css"], expected_css)
            self.assertEqual(model["tmpls"][0]["qfmt"], package.read_source(spec["front"]))
            self.assertEqual(model["tmpls"][0]["afmt"], package.read_source(spec["back"]))
            self.assertEqual([f["id"] for f in model["flds"]],
                             [spec["id"] * 100 + i + 1 for i in range(len(spec["fields"]))])
            if spec["kind"] == "basic":
                self.assertEqual(model["req"], [[0, "any", [0]]])
            if spec["kind"] == "occlusion":
                self.assertEqual(model["originalStockKind"], 6)
                self.assertEqual([f["tag"] for f in model["flds"]], [0, 1, 2, 3, 4])
        self.assertIn((package.ROOT / "LICENSE").read_text().strip(), package.read_source("media/_review.js"))
        for name in package.media_names():
            self.assertEqual((Path(collection.media.dir()) / name).read_bytes(),
                             (package.CARDS / "media" / name).read_bytes())
        for sample in package.samples():
            nid = collection.db.scalar("select id from notes where guid=?", package.sample_guid(sample["key"]))
            note = collection.get_note(nid)
            spec = next(s for s in package.specifications() if s["key"] == sample["type"])
            self.assertEqual(note.mid, spec["id"])
            self.assertEqual(note.fields, list(sample["fields"].values()))
            self.assertEqual(set(note.tags), set(sample["tags"]))
            for card in note.cards():
                self.assertIn('id="answer"', card.answer())
                self.assertNotIn("{{FrontSide}}", card.answer())
                self.assertEqual((card.type, card.queue, card.reps), (0, 0, 0))
        data = package.preview_data(collection)
        self.assertEqual(data, json.loads(TEST_PREVIEW.read_text()))
        return data

    def test_download_import_and_preview(self):
        collection = self.collection()
        data = self.check_collection(collection)
        # 可独立排程的填空和原生图片遮挡，不由模板 JS 临时生成。
        for example in data:
            if example["key"] == "cloze":
                self.assertEqual(len(example["cards"]), 3)
                self.assertIn('class="cloze"', example["cards"][0]["front"])
            if example["key"] == "occlusion":
                self.assertEqual(len(example["cards"]), 2)
                self.assertIn('data-shape="rect"', example["cards"][0]["front"])
            if example["type"] in ("basic", "choice"):
                self.assertNotIn('data-answer', example["cards"][0]["front"])
                self.assertNotIn('review-explanation', example["cards"][0]["front"])
        if os.environ.get("ANKI_RENDER_OUTPUT"):
            path = Path(os.environ["ANKI_RENDER_OUTPUT"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            web = importlib.metadata.distribution("aqt").locate_file("_aqt/data/web")
            (path.parent / "anki-web.json").write_text(json.dumps(str(web.resolve())))
            choice = next(s for s in package.specifications() if s["key"] == "choice")
            model = collection.models.get(choice["id"])
            cases = {}
            for key, options, answer, question_type in (
                ("fixed", "第一项||第二项||第三项||第四项", "C", "单选"),
                ("fixed_multi", "第一项||第二项||第三项||第四项", "AC", "多选"),
                ("duplicates", '同一内容||<b>富文本 ` ${value}</b>||同一内容', "C", "单选"),
                ("literal", "第一项||第二项", "直接核对这段答案", "单选"),
                ("maximum", "||".join(f"选项 {i}" for i in range(26)), "AZ", "多选"),
            ):
                note = collection.new_note(model)
                note["问题"], note["选项"], note["答案"], note["题型"] = key, options, answer, question_type
                note.tags = ["固定顺序"] if key.startswith("fixed") else []
                collection.add_note(note, collection.decks.id_for_name(package.DECK_NAME))
                card = note.cards()[0]
                cases[key] = {"front": card.question(), "back": card.answer()}
            (path.parent / "choice-cases.json").write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")

    def test_native_occlusion_editor_recognizes_note(self):
        collection = self.collection()
        spec = next(s for s in package.specifications() if s["key"] == "occlusion")
        indexes = collection._backend.get_image_occlusion_fields(spec["id"])
        self.assertEqual((indexes.occlusions, indexes.image, indexes.header, indexes.back_extra), (0, 1, 2, 3))
        nid = collection.db.scalar("select id from notes where guid=?", package.sample_guid("occlusion"))
        source = collection._backend.get_image_occlusion_note(nid).note
        self.assertEqual(source.image_file_name, "_rule-build.svg")
        self.assertEqual(source.image_data, (package.CARDS / "media/_rule-build.svg").read_bytes())
        self.assertEqual({group.ordinal for group in source.occlusions}, {1, 2})
        self.assertTrue(source.occlude_inactive)

    def test_rebuild_from_sources(self):
        source = package.build_package(self.directory / "rebuilt.apkg", preview=None)
        self.check_collection(self.collection("rebuilt", source))

    def test_reimport_preserves_schedule_without_duplicates(self):
        collection = self.collection()
        schedules = {}
        for index, cid in enumerate(collection.find_cards("")):
            card = collection.get_card(cid)
            card.type = card.queue = 2
            card.ivl, card.reps, card.due = 23 + index, 7, 100 + index
            collection.update_card(card)
            schedules[cid] = (2, 2, 23 + index, 7, 100 + index)
        self.import_into(collection, TEST_PACKAGE)
        rebuilt = package.build_package(self.directory / "rebuilt.apkg", preview=None)
        self.import_into(collection, rebuilt)
        self.assertEqual(collection.note_count(), 9)
        self.assertEqual(len(collection.find_cards("")), 14)
        for spec in package.specifications():
            self.assertEqual(len([m for m in collection.models.all() if m["name"] == spec["name"]]), 1)
        for cid, schedule in schedules.items():
            saved = collection.get_card(cid)
            self.assertEqual((saved.type, saved.queue, saved.ivl, saved.reps, saved.due), schedule)

    def test_template_update_preserves_user_notes(self):
        collection = self.collection()
        saved = []
        schedules = {}
        specs = package.specifications()
        for spec in specs:
            note = collection.new_note(collection.models.get(spec["id"]))
            note.fields = list(next(s for s in package.samples() if s["type"] == spec["key"])["fields"].values())
            note.tags = ["用户内容"]
            collection.add_note(note, collection.decks.id_for_name(package.DECK_NAME))
            saved.append(note)
            for card in note.cards():
                card.type = card.queue = 2
                card.ivl, card.reps, card.due = 60, 8, 120
                collection.update_card(card)
                schedules[card.id] = (2, 2, 60, 8, 120)
        original = package.read_source
        css = original("style.css") + "\n/* update regression */\n"
        replacements = {"style.css": css}
        for spec in specs:
            for side in ("front", "back"):
                name = spec[side]
                replacements[name] = original(name) + "\n<!-- update regression -->\n"
        timestamp = max(collection.models.get(s["id"])["mod"] for s in specs) + 10
        with patch.object(package, "read_source", side_effect=lambda name: replacements.get(name, original(name))):
            rebuilt = package.build_package(self.directory / "updated.apkg", preview=None, timestamp=timestamp)
        self.import_into(collection, rebuilt)
        for spec in specs:
            model = collection.models.get(spec["id"])
            self.assertEqual(model["css"], css + ("\n" + original(spec["css"]) if spec.get("css") else ""))
            self.assertEqual(model["tmpls"][0]["qfmt"], replacements[spec["front"]])
            self.assertEqual(model["tmpls"][0]["afmt"], replacements[spec["back"]])
        for note in saved:
            self.assertEqual(collection.get_note(note.id).fields, note.fields)
            self.assertEqual(collection.get_note(note.id).tags, note.tags)
        for cid, schedule in schedules.items():
            card = collection.get_card(cid)
            self.assertEqual((card.type, card.queue, card.ivl, card.reps, card.due), schedule)
        self.assertEqual(collection.note_count(), 14)

    def test_empty_question_is_reported_by_anki(self):
        collection = self.collection()
        for spec in package.specifications():
            if spec["kind"] != "basic":
                continue
            model = collection.models.get(spec["id"])
            note = collection.new_note(model)
            note["章节"] = "只有章节"
            if spec["key"] == "choice":
                note["题型"] = "多选"
                note["选项"] = "A||B"
            collection.add_note(note, collection.decks.id_for_name(package.DECK_NAME))
            self.assertNotIn('data-review=', note.cards()[0].question())
            report = collection.get_empty_cards()
            self.assertIn(note.cards()[0].id, [cid for group in report.notes for cid in group.card_ids])
            self.assertEqual(model["req"], [[0, "any", [0]]])

    def test_question_and_choice_have_separate_fields_and_shared_back(self):
        specs = {s["key"]: s for s in package.specifications()}
        self.assertNotEqual(specs["basic"]["id"], specs["choice"]["id"])
        self.assertNotIn("选项", specs["basic"]["fields"])
        self.assertNotIn("题型", specs["basic"]["fields"])
        self.assertIn("选项", specs["choice"]["fields"])
        self.assertIn("题型", specs["choice"]["fields"])
        self.assertEqual(specs["basic"]["back"], specs["choice"]["back"])

    def test_usage_field_examples_match_package_samples(self):
        usage_path = package.ROOT / "docs/usage.md"
        usage = usage_path.read_text()
        samples = {s["key"]: s for s in package.samples()}
        blocks = re.findall(r"```text\n(.*?)\n```", usage, re.S)
        self.assertEqual(len(blocks), 4)
        for block, key in zip(blocks[:3], ("single", "multiple", "judgment")):
            fields = dict(line.split("：", 1) for line in block.splitlines())
            self.assertEqual(fields, {f: samples[key]["fields"][f] for f in ("问题", "选项", "答案", "题型")})
        self.assertEqual(blocks[3].replace("\n", ""), samples["cloze"]["fields"]["正文"])
        mindmap_section = usage.split('### 思维导图', 1)[1]
        mindmap_html = re.search(r'```html\n(.*?)\n```', mindmap_section, re.S).group(1)
        # Editor-friendly line indentation is not content.
        mindmap_html = re.sub(r'\s*\n\s*', '', mindmap_html)
        self.assertEqual(mindmap_html, samples["mindmap"]["fields"]["内容"])
        recall = samples["recall"]["fields"]
        self.assertIn("问题：" + recall["问题"], usage)
        self.assertIn("答案：" + re.sub(r"<[^>]+>", "", recall["答案"]), usage)
        for name in re.findall(r'^<img src="([^"]+)"', usage, re.M):
            self.assertTrue((usage_path.parent / name).read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))

    def test_rich_fields_are_never_inserted_into_script(self):
        collection = self.collection()
        model = collection.models.get(package.specifications()[0]["id"])
        note = collection.new_note(model)
        note["问题"] = '<p>反引号 `，引号 "，表达式 ${value} 与中文。</p>'
        note["答案"] = '<b>完整的 <code>HTML</code> 答案</b>'
        collection.add_note(note, collection.decks.id_for_name(package.DECK_NAME))
        card = note.cards()[0]
        self.assertIn(note["问题"], card.question())
        self.assertIn(note["答案"], card.answer())
        self.assertNotIn(note["答案"], card.question())


if __name__ == "__main__":
    unittest.main()
