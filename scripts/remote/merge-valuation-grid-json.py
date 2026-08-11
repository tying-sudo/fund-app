#!/usr/bin/env python3
"""Strict three-way JSON merge driver for valuation-grid runtime data."""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


class MergeConflict(Exception):
    """Raised when both sides changed a value that cannot be merged safely."""


class InputError(Exception):
    """Raised when an input or output file cannot be handled safely."""


class _Missing:
    pass


MISSING = _Missing()
OTHER_SNAPSHOT_TIMESTAMP = None
MERGE_PATH = None
BEIJING_TIMEZONE = timezone(timedelta(hours=8))

IDENTITY_FIELDS = (
    ("id",),
    ("request_id",),
    ("ledger_id",),
    ("record_id",),
    ("batch_id",),
    ("uuid",),
    ("date", "time", "source", "action", "signal_name"),
    ("date", "time"),
    ("date",),
)


def _json_equal(left, right):
    if left is MISSING or right is MISSING:
        return left is right
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return (
            left.keys() == right.keys()
            and all(_json_equal(left[key], right[key]) for key in left)
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _json_equal(a, b) for a, b in zip(left, right)
        )
    return left == right


def _ordered_union(*iterables):
    seen = set()
    result = []
    for iterable in iterables:
        for item in iterable:
            if item not in seen:
                seen.add(item)
                result.append(item)
    return result


def _identity_component(value):
    if value is None or isinstance(value, (dict, list)):
        return None
    if isinstance(value, str) and not value:
        return None
    return (type(value).__name__, value)


def _record_identity(record, fields):
    parts = []
    for field in fields:
        if field not in record:
            return None
        component = _identity_component(record[field])
        if component is None:
            return None
        parts.append(component)
    return (fields, tuple(parts))


def _index_records(records, fields):
    indexed = {}
    for record in records:
        if not isinstance(record, dict):
            return None
        identity = _record_identity(record, fields)
        if identity is None or identity in indexed:
            return None
        indexed[identity] = record
    return indexed


def _select_record_indexes(ancestor, current, other):
    for fields in IDENTITY_FIELDS:
        indexes = tuple(
            _index_records(records, fields)
            for records in (ancestor, current, other)
        )
        if all(index is not None for index in indexes):
            return indexes
    return None


def _path_key(path, key):
    return "%s[%s]" % (path, json.dumps(key, ensure_ascii=False))


def _parse_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BEIJING_TIMEZONE)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _snapshot_timestamp(value, fallback=None):
    if not isinstance(value, dict):
        return None
    date_value = value.get("date")
    if not isinstance(date_value, str) or not date_value.strip():
        return None

    time_value = None
    for field in ("asof_time", "updated_at", "timestamp", "time"):
        candidate = value.get(field)
        if isinstance(candidate, str) and candidate.strip():
            time_value = candidate.strip()
            break

    raw = date_value.strip()
    if time_value:
        if "T" in time_value or " " in time_value:
            raw = time_value
        else:
            raw = "%sT%s" % (raw, time_value)
    elif fallback is not None:
        fallback_date = (
            fallback.replace(tzinfo=timezone.utc)
            .astimezone(BEIJING_TIMEZONE)
            .date()
            .isoformat()
        )
        if raw == fallback_date:
            return fallback
    parsed = _parse_timestamp(raw)
    return parsed


def _merge_dict(ancestor, current, other, path):
    keys = _ordered_union(ancestor.keys(), current.keys(), other.keys())
    merged = {}
    for key in keys:
        value = merge_value(
            ancestor.get(key, MISSING),
            current.get(key, MISSING),
            other.get(key, MISSING),
            _path_key(path, key),
        )
        if value is not MISSING:
            merged[key] = value
    return merged


def _merge_record_list(ancestor, current, other, path):
    list_kind = _list_kind(ancestor, current, other, path)
    if list_kind is None:
        raise MergeConflict("%s: changed list has no recognized merge schema" % path)
    indexes = _select_record_indexes(ancestor, current, other)
    if indexes is None:
        raise MergeConflict("%s: changed list has no safe unique record key" % path)

    ancestor_index, current_index, other_index = indexes
    identities = _ordered_union(
        ancestor_index.keys(), current_index.keys(), other_index.keys()
    )
    merged = []
    for ordinal, identity in enumerate(identities):
        value = merge_value(
            ancestor_index.get(identity, MISSING),
            current_index.get(identity, MISSING),
            other_index.get(identity, MISSING),
            "%s[record:%d]" % (path, ordinal),
        )
        if value is not MISSING:
            merged.append(value)
    return _sort_record_list(merged, list_kind, path)


def _list_kind(ancestor, current, other, path):
    if MERGE_PATH is None:
        return "generic"
    if MERGE_PATH == "data/confidence_deviations.json":
        return "confidence"
    if MERGE_PATH == "data/signal_history.json":
        return "signals"
    return "generic"


def _record_sort_key(record, list_kind, path):
    date_value = record.get("date")
    if not isinstance(date_value, str) or not date_value.strip():
        raise MergeConflict("%s: record has no ISO date for ordering" % path)
    if list_kind == "confidence":
        return (date_value,)
    time_value = record.get("time")
    if not isinstance(time_value, str) or not time_value.strip():
        raise MergeConflict("%s: signal record has no time for ordering" % path)
    return (date_value, time_value)


def _sort_record_list(records, list_kind, path):
    if list_kind == "generic":
        return records
    ordered = sorted(
        records,
        key=lambda record: _record_sort_key(record, list_kind, path),
        reverse=list_kind == "confidence",
    )
    return ordered


def merge_value(ancestor, current, other, path="$"):
    if _json_equal(current, other):
        return current
    if _json_equal(current, ancestor):
        return other
    if _json_equal(other, ancestor):
        return current

    if current is MISSING or other is MISSING:
        raise MergeConflict("%s: deletion conflicts with modification" % path)

    if isinstance(current, dict) and isinstance(other, dict):
        current_timestamp = _snapshot_timestamp(current)
        other_timestamp = _snapshot_timestamp(other, OTHER_SNAPSHOT_TIMESTAMP)
        if (
            MERGE_PATH == "data/intraday_cache.json"
            and
            current_timestamp is not None
            and other_timestamp is not None
            and current_timestamp != other_timestamp
        ):
            return current if current_timestamp > other_timestamp else other
        if ancestor is MISSING:
            return _merge_dict({}, current, other, path)
        if isinstance(ancestor, dict):
            return _merge_dict(ancestor, current, other, path)

    if isinstance(current, list) and isinstance(other, list):
        if ancestor is MISSING:
            return _merge_record_list([], current, other, path)
        if isinstance(ancestor, list):
            return _merge_record_list(ancestor, current, other, path)

    raise MergeConflict("%s: both sides changed the same value" % path)


def _object_without_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate object key: %s" % key)
        result[key] = value
    return result


def _reject_non_json_constant(value):
    raise ValueError("invalid JSON constant: %s" % value)


def _load_json(path, label):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(
                handle,
                object_pairs_hook=_object_without_duplicate_keys,
                parse_constant=_reject_non_json_constant,
            )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise InputError("%s JSON error: %s" % (label, error)) from error


def _write_json(path, value):
    temporary_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=str(path.parent),
            prefix=".%s." % path.name,
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            os.chmod(temporary_path, path.stat().st_mode)
        os.replace(str(temporary_path), str(path))
    except (OSError, TypeError, ValueError) as error:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass
        raise InputError("current JSON write error: %s" % error) from error


def _parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Strict three-way JSON merge driver; overwrites --current on success."
    )
    parser.add_argument("--ancestor", required=True, type=Path)
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--other", required=True, type=Path)
    parser.add_argument("--other-timestamp")
    parser.add_argument("--path")
    return parser.parse_args(argv)


def main(argv=None):
    global MERGE_PATH, OTHER_SNAPSHOT_TIMESTAMP
    args = _parse_args(argv)
    MERGE_PATH = args.path
    if args.other_timestamp:
        OTHER_SNAPSHOT_TIMESTAMP = _parse_timestamp(args.other_timestamp)
        if OTHER_SNAPSHOT_TIMESTAMP is None:
            print("JSON merge input error: invalid --other-timestamp", file=sys.stderr)
            return 2
    try:
        ancestor = _load_json(args.ancestor, "ancestor")
        current = _load_json(args.current, "current")
        other = _load_json(args.other, "other")
        merged = merge_value(ancestor, current, other)
        if merged is MISSING:
            raise InputError("root JSON value cannot be deleted")
        _write_json(args.current, merged)
    except MergeConflict as error:
        print("JSON merge conflict: %s" % error, file=sys.stderr)
        return 1
    except InputError as error:
        print("JSON merge input error: %s" % error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
