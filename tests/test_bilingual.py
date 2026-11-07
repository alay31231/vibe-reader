from __future__ import annotations
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bilingual import load_parallel, parse_numbered
from server import DocumentStore

SOURCE = '---\ndoc_code: TEST-01\nlanguage: en\n---\n\n# Example\n\n[001] First original.\n\n[002] Second original.\n\n[003] Third original.\n'

class ParallelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'book.en.md'
        self.target = self.root / 'book.zh.md'
        self.source.write_text(SOURCE, encoding='utf8')
        self.store = DocumentStore([], import_dir=self.root / 'imports', parallel_roots=[self.root])

    def tearDown(self):
        self.temp.cleanup()

    def write_translation(self, text):
        self.target.write_text('---\ndoc_code: TEST-01\ntitle: 中文书名\n---\n\n' + text, encoding='utf8')

    def test_range_translation_is_grouped_once_and_keeps_line_provenance(self):
        self.write_translation('[001-002] 合译前两段。\n\n[003] 第三段。\n\n## 译注\n\n这是说明，不是原文。')
        result = load_parallel(self.source)
        pairs = [r for r in result['rows'] if r['kind'] == 'pair']
        self.assertEqual(len(pairs), 2)
        self.assertEqual((pairs[0]['start'], pairs[0]['end']), (1, 2))
        self.assertEqual(len(pairs[0]['source']), 2)
        self.assertEqual(pairs[0]['line'], 8)
        self.assertEqual(result['translated_count'], 3)
        self.assertIn('不是原文', result['translation_notes'][-1]['text'])

    def test_missing_translation_and_missing_paragraph_are_explicit(self):
        self.assertFalse(load_parallel(self.source)['translation_available'])
        self.write_translation('[002] 只有第二段。')
        result = load_parallel(self.source)
        self.assertEqual(result['translated_count'], 1)
        pairs = [r for r in result['rows'] if r['kind'] == 'pair']
        self.assertIsNone(pairs[0]['translation'])
        self.assertEqual(pairs[1]['translation']['text'], '只有第二段。')

    def test_overlaps_are_not_silently_paired(self):
        self.write_translation('[001-002] 合译。\n\n[002] 冲突。')
        result = load_parallel(self.source)
        self.assertEqual(result['translated_count'], 0)
        self.assertEqual(len(result['unpaired_translations']), 2)
        self.assertTrue(result['warnings'])

    def test_mismatched_document_code_disables_pairing(self):
        self.target.write_text('---\ndoc_code: WRONG\n---\n\n[001] 不同文件。', encoding='utf8')
        result = load_parallel(self.source)
        self.assertEqual(result['translated_count'], 0)
        self.assertTrue(result['warnings'])

    def test_duplicate_source_paragraphs_are_preserved_and_not_paired(self):
        self.source.write_text(SOURCE + '\n[001] Duplicate original.', encoding='utf8')
        self.write_translation('[001] 译文。')
        result = load_parallel(self.source)
        self.assertEqual(len([r for r in result['rows'] if r['kind'] == 'pair']), 4)
        self.assertEqual(result['translated_count'], 0)
        self.assertTrue(result['warnings'])

    def test_search_in_chinese_returns_original_paragraph_not_translation_line(self):
        self.write_translation('[002] 中文独有关键词。')
        documents = self.store.list_documents()
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0]['title'], '中文书名')
        results = self.store.search('独有关键词')
        self.assertEqual((results[0]['paragraph'], results[0]['line']), (2, 10))
        self.assertEqual(results[0]['doc_code'], 'TEST-01')
        self.assertEqual(len(self.store.resolve_code('test-01')), 1)

    def test_translation_cache_refreshes_when_companion_changes(self):
        doc = self.store.list_documents()[0]
        self.assertEqual(doc['translated_count'], 0)
        self.write_translation('[001] 新译文。')
        self.assertEqual(self.store.get_document(doc['id'])['translated_count'], 1)
        self.target.unlink()
        self.assertEqual(self.store.get_document(doc['id'])['translated_count'], 0)

    def test_asset_fallback_stays_within_explicitly_mounted_raw_library(self):
        original = self.root / '_markdown'
        translated = self.root / '_translation'
        original.mkdir(); translated.mkdir()
        (translated / 'book.en.md').write_text(SOURCE, encoding='utf8')
        ((original / 'figure.png').resolve()).write_bytes(b'picture')
        store = DocumentStore([original], import_dir=self.root / 'imports', parallel_roots=[translated])
        doc = store.list_documents()[0]
        self.assertEqual(store.get_asset(doc['id'], 'figure.png'), (original / 'figure.png').resolve())
        self.assertIsNone(store.get_asset(doc['id'], '../outside.png'))

if __name__ == '__main__': unittest.main()
