"""Read numbered source/translation pairs without modifying the research corpus."""
from __future__ import annotations

import re
from pathlib import Path
from collections import Counter

NUMBER = re.compile(r"^\[(\d+)(?:-(\d+))?\]\s+([\s\S]*)$")


def parse_numbered(text: str) -> dict:
    lines = text.splitlines()
    metadata = {}
    offset = 0
    if lines and lines[0].strip() == '---':
        for index, line in enumerate(lines[1:], 1):
            if line.strip() == '---':
                offset = index + 1
                break
            match = re.match(r'^([\w_]+):\s*(.*?)\s*$', line)
            if match:
                metadata[match[1]] = match[2].strip('\"\'')
    items = []
    index = offset
    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        start = index
        while index < len(lines) and lines[index].strip():
            index += 1
        content = '\n'.join(lines[start:index])
        match = NUMBER.match(content)
        if match:
            first, last = int(match[1]), int(match[2] or match[1])
            items.append(dict(kind='paragraph', start=first, end=last,
                              text=match[3], line=start + 1, end_line=index))
        elif re.match(r'^#{1,6}\s+', content):
            items.append(dict(kind='heading', text=content, line=start + 1, end_line=index))
        elif not re.fullmatch(r'<!--.*?-->', content, re.S):
            items.append(dict(kind='note', text=content, line=start + 1, end_line=index))
    return dict(metadata=metadata, items=items)


def load_parallel(source_path: Path) -> dict:
    source = parse_numbered(source_path.read_text(encoding='utf-8-sig'))
    target_path = source_path.with_name(source_path.name.removesuffix('.en.md') + '.zh.md')
    target = parse_numbered(target_path.read_text(encoding='utf-8-sig')) if target_path.is_file() else dict(metadata={}, items=[])
    paragraphs = [item for item in source['items'] if item['kind'] == 'paragraph']
    source_numbers = [item['start'] for item in paragraphs]
    available = set(source_numbers)
    source_counts = Counter(source_numbers)
    warnings = []
    if len(available) != len(source_numbers):
        warnings.append('原文存在重复段号，请核对材料；同号内容不会自动合并。')
    translations = {}
    translation_rows = [item for item in target['items'] if item['kind'] == 'paragraph']
    counts = {}
    for item in translation_rows:
        if item['start'] > item['end'] or item['end'] - item['start'] > len(paragraphs):
            warnings.append(f"译文段号范围无效：{item['start']}–{item['end']}")
            continue
        for number in range(item['start'], item['end'] + 1):
            counts[number] = counts.get(number, 0) + 1
    for item in translation_rows:
        numbers = list(range(item['start'], min(item['end'], item['start'] + len(paragraphs)) + 1))
        if not numbers or item['end'] - item['start'] > len(paragraphs) or any(source_counts[n] != 1 or counts.get(n, 0) != 1 for n in numbers):
            warnings.append(f"译文段号缺少对应原文或发生重叠：{item['start']}–{item['end']}；已保留在未配对译文中。")
            continue
        for number in numbers:
            translations[number] = item
    # A range translation is shown once below the complete source range.
    rows = []
    consumed = set()
    paired_targets = set()
    translated_count = 0
    for item in source['items']:
        if item['kind'] != 'paragraph':
            rows.append(item)
            continue
        number = item['start']
        if item['line'] in consumed:
            continue
        translation = translations.get(number)
        members = [item]
        if translation and translation['end'] > number:
            members = [p for p in paragraphs if number <= p['start'] <= translation['end']]
        for member in members:
            consumed.add(member['line'])
        if translation:
            paired_targets.add(translation['line'])
            translated_count += len(members)
        rows.append(dict(kind='pair', start=number, end=members[-1]['end'],
                         line=item['line'], end_line=members[-1]['end_line'],
                         source=members, translation=translation))
    notes = []
    for index, item in enumerate(target['items']):
        if item['kind'] == 'note':
            notes.append(item)
        elif item['kind'] == 'heading':
            following = next((other for other in target['items'][index + 1:] if other['kind'] != 'heading'), None)
            if following and following['kind'] == 'note':
                notes.append(item)
    unpaired = [item for item in translation_rows if item['line'] not in paired_targets]
    code = source['metadata'].get('doc_code', '')
    target_code = target['metadata'].get('doc_code', '')
    if target_code and code != target_code:
        # A wrong companion file must never be presented as an aligned translation.
        warnings.append('原译文文档码不一致，已停止自动配对，请核对材料。')
        for row in rows:
            if row['kind'] == 'pair':
                row['translation'] = None
        translated_count = 0
        unpaired = translation_rows
    return dict(code=code, source_language=source['metadata'].get('language', ''),
                title=target['metadata'].get('title'), paragraph_count=len(paragraphs),
                translated_count=translated_count, translation_available=target_path.is_file(),
                translation_name=target_path.name if target_path.is_file() else None,
                rows=rows, translation_notes=notes, unpaired_translations=unpaired, warnings=warnings)
