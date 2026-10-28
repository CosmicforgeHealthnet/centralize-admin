#!/usr/bin/env python3
"""Classify each manifest migration against a live database's object NAMES.

Input: the preflight report (schemaNames: tables, types, indexes, columns,
ledger) and the repository's manual-migration manifest. Runs on the CI runner;
it never connects to a database.

For every migration it extracts the objects the file creates (tables, enum and
domain types, indexes, added columns) and reports:
  present - every created object exists      partial - some exist
  absent  - none exist                       no_sentinel - creates nothing named
plus whether the migration ledger records it (and with the manifest checksum).

This is evidence for a decision, not a decision: "present" means the objects
exist by name, not that their definitions match. Before any ledger row is
written for a present-but-unrecorded migration, the definitions must be proven
by `npm run db:replay:verify` / `prisma migrate diff` against a restored copy.
"""
import json
import re
import sys
from pathlib import Path

IDENT = r'"?(\w+)"?'
SCHEMA = r'(?:"?public"?\.)?'
PATTERNS = {
    'tables': re.compile(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?' + SCHEMA + IDENT, re.I),
    'types': re.compile(r'CREATE\s+(?:TYPE|DOMAIN)\s+' + SCHEMA + IDENT, re.I),
    'indexes': re.compile(r'CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?' + IDENT, re.I),
}
ALTER_ADD = re.compile(r'ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?' + SCHEMA + IDENT + r'(.*?);', re.I | re.S)
ADD_COLUMN = re.compile(r'ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?' + IDENT, re.I)
COMMENT = re.compile(r'--[^\n]*')
DROPS = {
    'tables': re.compile(r'DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?' + SCHEMA + IDENT, re.I),
    'types': re.compile(r'DROP\s+(?:TYPE|DOMAIN)\s+(?:IF\s+EXISTS\s+)?' + SCHEMA + IDENT, re.I),
    'indexes': re.compile(r'DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?' + SCHEMA + IDENT, re.I),
}


def dropped_objects(sql):
    sql = COMMENT.sub('', sql)
    return {kind: set(p.findall(sql)) for kind, p in DROPS.items()}


def created_objects(sql):
    sql = COMMENT.sub('', sql)
    found = {kind: sorted(set(p.findall(sql))) for kind, p in PATTERNS.items()}
    columns = set()
    for table, body in ALTER_ADD.findall(sql):
        for col in ADD_COLUMN.findall(body):
            columns.add(f'{table}.{col}')
    found['columns'] = sorted(columns)
    return found


def classify(report, manifest_dir):
    names = report.get('schemaNames') or {}
    have = {kind: set(names.get(kind) or []) for kind in ('tables', 'types', 'indexes', 'columns')}
    ledger = {}
    for row in names.get('ledger') or []:
        file, _, sha = row.rpartition(':')
        ledger[file] = sha
    manifest = json.loads((manifest_dir / 'manifest.json').read_text())
    entries = sorted(manifest['migrations'], key=lambda e: e['order'])
    sql = {e['file']: (manifest_dir / e['file']).read_text() for e in entries}
    out = []
    for i, entry in enumerate(entries):
        objs = created_objects(sql[entry['file']])
        # An object this file or a LATER file drops (a replaced index, a renamed
        # table) cannot prove anything, so it is not used as a sentinel.
        for later in entries[i:]:
            for kind, names_dropped in dropped_objects(sql[later['file']]).items():
                objs[kind] = [n for n in objs[kind] if n not in names_dropped]
        total = sum(len(v) for v in objs.values())
        hit = sum(1 for kind, v in objs.items() for name in v if name in have[kind])
        status = 'no_sentinel' if total == 0 else 'present' if hit == total else 'absent' if hit == 0 else 'partial'
        missing = sorted(f'{kind}:{n}' for kind, v in objs.items() for n in v if n not in have[kind])
        out.append({
            'order': entry['order'], 'file': entry['file'], 'objectsStatus': status,
            'objectsCreated': total, 'objectsPresent': hit,
            'missingSample': missing[:10],
            'inLedger': entry['file'] in ledger,
            'ledgerChecksumMatches': ledger.get(entry['file']) == entry['sha256'] if entry['file'] in ledger else None,
        })
    return {
        'database': names.get('database'),
        'ledgerTablePresent': names.get('ledgerTablePresent'),
        'ledgerRows': len(ledger),
        'migrations': out,
        'summary': {s: [m['order'] for m in out if m['objectsStatus'] == s]
                    for s in ('present', 'partial', 'absent', 'no_sentinel')},
    }


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: ca-migration-state.py <preflight.json> <manual-migrations dir>')
    report = json.loads(Path(sys.argv[1]).read_text())
    if not report.get('schemaNames'):
        sys.exit('preflight report has no schemaNames')
    print(json.dumps(classify(report, Path(sys.argv[2])), indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
