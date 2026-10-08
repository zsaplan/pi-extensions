#!/usr/bin/env python3
"""Extract parent context from saved Pi sessions; no model, tool or DB calls.

See README.md for metric semantics and failure cases. Output never overwrites
existing evidence. Only explicit input files are read; message bodies are not
copied to the resulting report.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path

INPUT_FIELDS = ("input", "cacheRead", "cacheWrite")


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Session timestamps must include a timezone")
    return result


def active_branch(entries):
    by_id = {}
    for entry in entries:
        if "id" not in entry or entry["id"] in by_id:
            raise ValueError("Missing or duplicate session entry ID")
        by_id[entry["id"]] = entry
    branch, seen = [], set()
    current = entries[-1]["id"] if entries else None
    while current is not None:
        if current not in by_id or current in seen:
            raise ValueError("Broken or cyclic session parent chain")
        seen.add(current)
        entry = by_id[current]
        branch.append(entry)
        current = entry["parentId"]
    return list(reversed(branch))


def analyze(path):
    raw = path.read_bytes()
    rows = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not rows or rows[0].get("type") != "session":
        raise ValueError(f"Missing session header: {path}")
    header = rows[0]
    boundary = timestamp(header["timestamp"])
    branch = active_branch(rows[1:])
    fresh = [e for e in branch if timestamp(e["timestamp"]) >= boundary]
    fresh_ids = {e["id"] for e in fresh}
    abandoned = [e["id"] for e in rows[1:]
                 if timestamp(e["timestamp"]) >= boundary and e["id"] not in fresh_ids]
    requests = []
    for entry in fresh:
        message = entry.get("message", {})
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        parts = [usage.get(key) for key in INPUT_FIELDS]
        valid = (all(type(n) is int and n >= 0 for n in parts)
                 and sum(parts) > 0
                 and message.get("stopReason") in ("stop", "toolUse", "length"))
        requests.append({
            "entryId": entry["id"], "timestamp": entry["timestamp"],
            "provider": message.get("provider"), "model": message.get("model"),
            "stopReason": message.get("stopReason"),
            "inputTokens": sum(parts) if valid else None,
            "reportedUsage": {key: usage.get(key) for key in
                              (*INPUT_FIELDS, "output", "totalTokens")},
        })
    reported = [r["inputTokens"] for r in requests if r["inputTokens"] is not None]
    first = requests[0]["inputTokens"] if requests else None
    last = requests[-1]["inputTokens"] if requests else None
    messages = [e["message"] for e in fresh
                if e.get("message", {}).get("role") in ("user", "assistant", "toolResult")]
    completed = bool(messages and messages[-1].get("role") == "assistant"
                     and messages[-1].get("stopReason") == "stop"
                     and not any(c.get("type") == "toolCall"
                                 for c in messages[-1].get("content", [])))
    return {
        "session": str(path), "sessionId": header["id"],
        "sha256": hashlib.sha256(raw).hexdigest(),
        "parentSession": header.get("parentSession"),
        "completed": completed,
        "newUserMessageCount": sum(m.get("role") == "user" for m in messages),
        "abandonedFreshEntryIds": abandoned,
        "freshParentRequests": len(requests), "reportedRequests": len(reported),
        "coverageComplete": bool(requests) and len(reported) == len(requests),
        "unknownUsageEntryIds": [r["entryId"] for r in requests if r["inputTokens"] is None],
        "firstInputTokens": first, "lastInputTokens": last,
        "peakInputTokens": max(reported) if reported else None,
        "growthInputTokens": last - first if first is not None and last is not None else None,
        "cumulativeReportedInputTokens": sum(reported) if reported else None,
        "contextChanges": [{"entryId": e["id"], "type": e["type"], "timestamp": e["timestamp"]}
                           for e in fresh if e["type"] in ("compaction", "context_edit", "branch_summary")],
        "requests": requests,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("sessions", nargs="+", type=Path)
    args = parser.parse_args()
    paths = [p.resolve(strict=True) for p in args.sessions]
    if len(paths) != len(set(paths)):
        parser.error("Duplicate input session paths")
    output = {
        "metricRevision": "parent-input-context-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "extractorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "formula": "usage.input + usage.cacheRead + usage.cacheWrite per fresh parent assistant request",
        "caveats": [
            "Peak is an observed lower bound when request usage is missing/zero/failed.",
            "Inherited requests and nested usage are excluded; inherited context in new inputs is included.",
            "Input excludes the current response; cumulative input is not context-window occupancy.",
            "A completed run is not proof of quality; inspect branching, user messages and context changes.",
        ],
        "sessions": [analyze(p) for p in paths],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(output, file, indent=2)
        file.write("\n")
    for run in output["sessions"]:
        print(f'{run["sessionId"]}: first={run["firstInputTokens"]}, '
              f'last={run["lastInputTokens"]}, peak={run["peakInputTokens"]}, '
              f'growth={run["growthInputTokens"]}; coverage={run["reportedRequests"]}/'
              f'{run["freshParentRequests"]}, completed={run["completed"]}')
    print(f"Evidence: {args.output}")


if __name__ == "__main__":
    main()
