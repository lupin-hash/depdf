"""Run with: python tests/analysis-engine.test.py (requires native PyMuPDF)."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('depdf_analysis_engine', Path(__file__).resolve().parents[1] / 'www/engine/pdf_engine.py')
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)
fitz = engine.fitz


class AnalysisPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.input = Path(self.temp.name) / 'source.pdf'
        self.output = Path(self.temp.name) / 'clean.pdf'

    def fixture(self, hidden=False, ocr=False):
        doc = fitz.open()
        page = doc.new_page(width=600, height=800)
        if ocr:
            page.insert_text((60, 400), 'Searchable scan text', render_mode=3)
        else:
            page.insert_text((60, 100), 'Header words')
            page.insert_text((60, 400), 'Body remains visible')
            page.insert_text((60, 750), 'Footer words')
            if hidden:
                page.insert_text((60, 300), 'Invisible tracker', render_mode=3)
        page.add_text_annot((400, 400), 'A reviewer comment')
        page.insert_link({'kind': fitz.LINK_URI, 'from': fitz.Rect(60, 390, 180, 410), 'uri': 'https://example.com/report'})
        doc.set_metadata({'author': '<img src=x onerror=globalThis.injected=1>', 'title': 'Example document'})
        doc.embfile_add('notes.txt', b'Attachment contents', filename='notes.txt')
        doc.save(self.input)
        doc.close()

    def options(self, **kwargs):
        return engine.CleanOptions(remove_metadata=False, remove_image_watermarks=False, **kwargs)

    def preview(self, options):
        before = hashlib.sha256(self.input.read_bytes()).digest()
        details = engine.preview_cleanup(str(self.input), options)
        self.assertEqual(hashlib.sha256(self.input.read_bytes()).digest(), before)
        self.assertFalse(self.output.exists())
        return details

    def assert_cleaned(self, options, removed, kept):
        engine.clean_pdf(str(self.input), str(self.output), options)
        with fitz.open(self.output) as doc:
            text = '\n'.join(p.get_text() for p in doc)
        for value in removed:
            self.assertNotIn(value, text)
        for value in kept:
            self.assertIn(value, text)

    def test_header_preview_matches_real_cleanup_without_changing_original(self):
        self.fixture()
        options = self.options(top_percent=25)
        details = self.preview(options)
        self.assertEqual(details['text']['total'], 2)
        self.assertEqual(details['text']['items'][0]['page'], 1)
        self.assertEqual(details['text']['items'][0]['text'], 'Header words')
        self.assert_cleaned(options, ['Header words'], ['Body remains visible', 'Footer words'])

    def test_off_settings_keep_text_but_still_explain_detected_items(self):
        self.fixture()
        details = self.preview(self.options())
        self.assertFalse(details['text']['enabled'])
        self.assertEqual(details['text']['items'], [])
        self.assertFalse(details['links']['enabled'])
        self.assertIn('https://example.com/report', details['links']['items'][0]['text'])
        self.assertIn('A reviewer comment', details['annotations']['items'][0]['text'])
        self.assertEqual(details['attachments']['items'][0]['text'], 'notes.txt')
        self.assertTrue(any('<img' in item['text'] for item in details['metadata']['items']))

    def test_footer_and_custom_area_are_included(self):
        self.fixture()
        options = self.options(bottom_percent=10, custom_regions=[(0, 45, 50, 55)])
        details = self.preview(options)
        text = details['text']['items'][0]['text']
        self.assertIn('Footer words', text)
        self.assertIn('Body remains visible', text)
        self.assertNotIn('Header words', text)
        self.assert_cleaned(options, ['Footer words', 'Body remains visible'], ['Header words'])

    def test_watermark_phrase_preview_uses_cleanup_rules(self):
        self.fixture()
        options = self.options(watermark_phrases=['Header words'])
        details = self.preview(options)
        self.assertIn('Header words', details['text']['items'][0]['text'])
        self.assert_cleaned(options, ['Header words'], ['Body remains visible'])

    def test_hidden_text_is_shown_and_actual_removals_match(self):
        self.fixture(hidden=True)
        options = self.options(remove_hidden_text=True)
        details = self.preview(options)
        self.assertTrue(any('Invisible tracker' in i['text'] for i in details['hidden']['items']))
        self.assertIn('Invisible tracker', '\n'.join(i['text'] for i in details['text']['items']))
        self.assert_cleaned(options, ['Invisible tracker'], ['Body remains visible'])

    def test_searchable_ocr_layer_is_protected(self):
        self.fixture(ocr=True)
        options = self.options(remove_hidden_text=True)
        details = self.preview(options)
        self.assertGreater(details['hidden']['ocr_kept'], 0)
        self.assertEqual(details['text']['total'], 0)
        self.assert_cleaned(options, [], ['Searchable scan text'])

    def test_job_protocol_returns_details_and_honors_options(self):
        self.fixture()
        result = json.loads(engine.run_job(json.dumps({'kind': 'analyze', 'input': str(self.input), 'options': {'top': 25, 'remove_links': True, 'remove_annotations': True, 'remove_extras': True}})))
        self.assertIn('Pages: 1', result['report'])
        self.assertEqual(result['details']['text']['total'], 2)
        self.assertTrue(result['details']['links']['enabled'])
        self.assertTrue(result['details']['annotations']['enabled'])
        self.assertTrue(result['details']['attachments']['enabled'])

    def history_fixture(self):
        doc = fitz.open()
        page = doc.new_page(width=600, height=800)
        page.insert_text((60, 100), 'Previous page version')
        doc.set_metadata({'author': 'OLD_REVISION_AUTHOR_MARKER', 'title': 'Old saved title'})
        doc.save(self.input)
        doc.close()
        old_copy = self.input.read_bytes()
        doc = fitz.open(self.input)
        page = doc[0]
        for xref in page.get_contents():
            doc.update_stream(xref, b'')
        page.insert_text((60, 100), 'Current version only')
        doc.set_metadata({'author': 'CURRENT_HISTORY_AUTHOR_MARKER', 'creationDate': 'D:20200101000000', 'modDate': 'D:20260101000000'})
        doc.set_xml_metadata('<x:xmpmeta xmlns:x="adobe:ns:meta/"><history>OLD_XMP_HISTORY_MARKER</history></x:xmpmeta>')
        private = doc.get_new_xref()
        doc.update_object(private, '<< /Source (PRIVATE_EDITOR_HISTORY_MARKER) >>')
        record = f'<< /Editor << /Private {private} 0 R /LastModified (D:20260101000000) >> >>'
        doc.xref_set_key(doc.pdf_catalog(), 'PieceInfo', record)
        doc.xref_set_key(page.xref, 'PieceInfo', record)
        doc.xref_set_key(page.xref, 'LastModified', '(D:20260101000000)')
        unused = doc.get_new_xref()
        doc.update_object(unused, '<< /Secret (UNREACHABLE_HISTORY_MARKER) >>')
        thumb = doc.get_new_xref()
        doc.update_object(thumb, '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Secret (THUMBNAIL_HISTORY_MARKER) >>')
        doc.update_stream(thumb, bytes([0, 0, 0]))
        doc.xref_set_key(page.xref, 'Thumb', f'{thumb} 0 R')
        doc.embfile_add('previous-version.pdf', old_copy, filename='previous-version.pdf')
        page.add_file_annot((400, 500), old_copy, filename='source-backup.pdf')
        note = page.add_text_annot((420, 400), 'Current comment stays')
        note.set_info(title='OLD_ANNOTATION_AUTHOR_MARKER', creationDate='D:20200101000000', modDate='D:20260101000000')
        doc.saveIncr()
        doc.close()

    def assert_no_saved_history(self, password=''):
        original = self.input.read_bytes()
        with engine.open_pdf(str(self.input), password) as source:
            source_ids = source.xref_get_key(-1, 'ID')[1]
        with fitz.open(self.output) as doc:
            self.assertFalse(doc.needs_pass)
            self.assertEqual(doc.xref_get_key(-1, 'Prev')[0], 'null')
            self.assertEqual(doc.xref_get_key(-1, 'Info')[0], 'null')
            self.assertEqual(doc.get_xml_metadata(), '')
            self.assertEqual(doc.embfile_count(), 0)
            new_ids = doc.xref_get_key(-1, 'ID')[1]
            self.assertFalse(set(re.findall(r'<([0-9A-Fa-f]+)>', source_ids)) & set(re.findall(r'<([0-9A-Fa-f]+)>', new_ids)))
            self.assertIn('Current version only', doc[0].get_text())
            self.assertTrue(any(a.info.get('content') == 'Current comment stays' for a in (doc[0].annots() or [])))
            recovered = []
            for xref in range(1, doc.xref_length()):
                recovered.append(doc.xref_object(xref).encode())
                if doc.xref_is_stream(xref):
                    recovered.append(doc.xref_stream(xref))
            recovered = b'\n'.join(recovered)
            for marker in [b'OLD_REVISION_AUTHOR_MARKER', b'CURRENT_HISTORY_AUTHOR_MARKER', b'OLD_XMP_HISTORY_MARKER', b'PRIVATE_EDITOR_HISTORY_MARKER', b'UNREACHABLE_HISTORY_MARKER', b'THUMBNAIL_HISTORY_MARKER', b'OLD_ANNOTATION_AUTHOR_MARKER']:
                self.assertNotIn(marker, recovered)
        self.assertEqual(self.input.read_bytes(), original)
        self.assertEqual(self.output.read_bytes().count(b'startxref'), 1)

    def test_clean_export_discards_revisions_private_records_and_embedded_copies(self):
        self.history_fixture()
        self.assertGreater(self.input.read_bytes().count(b'startxref'), 1)
        before = self.input.read_bytes()
        details = self.preview(self.options())
        self.assertTrue(details['history']['enabled'])
        self.assertIn('Earlier saved revisions found', details['history']['items'][0]['text'])
        self.assertTrue(details['metadata']['enabled'])
        self.assertTrue(details['attachments']['enabled'])
        engine.clean_pdf(str(self.input), str(self.output), self.options())
        self.assertEqual(self.input.read_bytes(), before)
        self.assert_no_saved_history()

    def test_unlock_also_discards_saved_history(self):
        self.history_fixture()
        engine.unlock_pdf(str(self.input), str(self.output), password="")
        self.assert_no_saved_history()

    def test_encrypted_unlock_strips_history_and_keeps_current_page(self):
        self.history_fixture()
        source_file = self.input
        for mode in [fitz.PDF_ENCRYPT_AES_128, fitz.PDF_ENCRYPT_AES_256]:
            with self.subTest(encryption=mode):
                encrypted = Path(self.temp.name) / f'encrypted-{mode}.pdf'
                with fitz.open(source_file) as doc:
                    doc.save(encrypted, encryption=mode, owner_pw='fixture-owner', user_pw='fixture-reader', garbage=4, clean=True, deflate=True)
                self.input = encrypted
                with engine.open_pdf(str(self.input), 'fixture-reader') as source:
                    self.assertIn('Current version only', source[0].get_text())
                engine.unlock_pdf(str(self.input), str(self.output), password='fixture-reader')
                self.assert_no_saved_history(password='fixture-reader')

    def test_large_documents_use_the_same_history_policy(self):
        self.history_fixture()
        large = Path(self.temp.name) / 'large.pdf'
        with fitz.open(self.input) as doc:
            for _ in range(99):
                doc.new_page()
            doc.save(large)
        self.input = large
        engine.clean_pdf(str(self.input), str(self.output), self.options())
        with fitz.open(self.output) as doc:
            self.assertEqual(len(doc), 100)
        self.assert_no_saved_history()

    def test_live_form_names_and_values_survive_history_cleanup(self):
        self.history_fixture()
        doc = fitz.open(self.input)
        page = doc[0]
        widget = fitz.Widget()
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_name = 'customer_name'
        widget.field_value = 'Current form value'
        widget.rect = fitz.Rect(60, 500, 240, 530)
        page.add_widget(widget)
        doc.saveIncr()
        doc.close()
        engine.clean_pdf(str(self.input), str(self.output), self.options())
        with fitz.open(self.output) as result:
            widgets = list(result[0].widgets())
            self.assertEqual(len(widgets), 1)
            self.assertEqual(widgets[0].field_name, 'customer_name')
            self.assertEqual(widgets[0].field_value, 'Current form value')

    def test_failed_export_does_not_replace_a_previous_verified_copy(self):
        self.fixture()
        with fitz.open() as previous:
            previous.new_page().insert_text((60, 100), 'Previous valid export')
            previous.save(self.output)
        original_output = self.output.read_bytes()
        original_input = self.input.read_bytes()
        def fail_save(doc, destination, **kwargs):
            Path(destination).write_bytes(b'Unverified partial export')
            raise RuntimeError('Simulated interrupted export')
        with patch.object(fitz.Document, 'save', fail_save):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                engine.clean_pdf(str(self.input), str(self.output), self.options())
        self.assertEqual(self.output.read_bytes(), original_output)
        self.assertEqual(self.input.read_bytes(), original_input)
        self.assertFalse(list(Path(self.temp.name).glob('depdf-history-*')))

    def test_invalid_bands_are_rejected(self):
        self.fixture()
        with self.assertRaises(ValueError):
            self.preview(self.options(top_percent=70, bottom_percent=40))


if __name__ == '__main__':
    unittest.main(verbosity=2)
