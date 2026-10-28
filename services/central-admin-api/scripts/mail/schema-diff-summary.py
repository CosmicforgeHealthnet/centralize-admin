#!/usr/bin/env python3
"""Read-only summary of pg_dump --schema-only diffs; never print SQL or credentials.

Only receives file paths created by a trusted CI job from the two databases in
the SAME Centralize Admin staging PostgreSQL container. Prints object names
and counts, not object definitions, data, connection strings or secret values.
This is diagnostic evidence, NOT authorization for a database cutover.
"""
import json
import re
import sys
from pathlib import Path

OBJECT = re.compile(r"^-- Name: (.*); Type: ([^;]+); Schema: ([^;]+); Owner: (.*)$")
SAFE = re.compile(r"^[A-Za-z0-9_., ()/-]+$")
MAX_DETAILS = 45


def safe_label(value):
    return value[:110] if SAFE.fullmatch(value) and len(value) <= 110 else "REDACTED_OBJECT_ID"


def catalog(path):
    blocks = {"PREAMBLE": []}
    current = "PREAMBLE"
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        match = OBJECT.fullmatch(line)
        if match:
            name, kind, schema, _ = match.groups()
            current = f"{kind} {schema}.{name}"
            if current in blocks:
                raise ValueError("duplicate pg_dump object marker")
            blocks[current] = []
            continue
        if line.lstrip().startswith("--") or not line.strip():
            continue
        # pg_dump versions may add a random psql restrict token. It is not SQL
        # schema content, and should not trigger a false mismatch.
        if line.startswith("\\restrict ") or line.startswith("\\unrestrict "):
            continue
        blocks[current].append(line.rstrip())
    return {k: "\n".join(v) for k, v in blocks.items()}


def main():
    if len(sys.argv) != 3:
        raise ValueError("two schema-only dump paths required")
    original, restored = catalog(sys.argv[1]), catalog(sys.argv[2])
    left, right = set(original), set(restored)
    added = sorted(right - left)
    missing = sorted(left - right)
    changed = sorted(k for k in left & right if original[k] != restored[k])
    differences = [
        {"kind": kind, "object": safe_label(name)}
        for kind, names in (("added_in_restore", added),
                            ("missing_from_restore", missing),
                            ("definition_differs", changed))
        for name in names
    ]
    result = {
        "comparison": "CA staging original vs staging restore test",
        "source_object_count": len(original) - 1,
        "restored_object_count": len(restored) - 1,
        "schema_semantically_equal": not differences,
        "diff_counts": {
            "added_in_restore": len(added),
            "missing_from_restore": len(missing),
            "definition_differs": len(changed),
        },
        "differing_objects": differences[:MAX_DETAILS],
        "truncated": len(differences) > MAX_DETAILS,
        "safe_to_cutover": False,
        "note": "Inspection only; no SQL applied or database cutover authorized.",
    }
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        # Never print path, exception, raw SQL or credentials from runtime.
        print(json.dumps({"error": "SCHEMA_COMPARISON_FAILED", "safe_to_cutover": False}))
        sys.exit(1)
