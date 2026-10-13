"""Read-only measurement shared by planned trials and existing Pi sessions."""
from collections import Counter
import hashlib
import json
import math
import shutil
from pathlib import Path

from context_usage import active_branch, analyze, timestamp
from experiments import digest, load, save


def jsonl(path):
    # JSONL framing is LF, not Python's broader Unicode splitlines().
    if path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError('Evidence exceeds 128 MiB; retain it for manual inspection')
    return [json.loads(line) for line in path.read_text().split('\n') if line.strip()]


def cost(usage):
    if not isinstance(usage, dict):
        return None
    if not isinstance(usage.get('cost'), dict):
        return None
    value = usage['cost'].get('total')
    tokens = [usage.get(k) for k in ('input', 'output', 'cacheRead', 'cacheWrite')]
    if (type(value) not in (int, float) or not math.isfinite(value) or value < 0
            or any(type(n) is not int or n < 0 for n in tokens) or sum(tokens) == 0):
        return None
    return value


def totals(usages):
    values = [cost(u) for u in usages]
    return {'known': sum(v for v in values if v is not None),
            'complete': all(v is not None for v in values), 'records': len(values)}


def signature(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def copy_evidence(source, destination):
    if not source.is_file() or source.stat().st_size > 128 * 1024 * 1024:
        raise ValueError(f'Evidence must be a regular file of at most 128 MiB: {source}')
    shutil.copyfile(source, destination)


def measure(session, output, child_root, events=None):
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    copied = output / 'parent-session.jsonl'
    copy_evidence(session, copied)
    if events is not None:
        copy_evidence(events, output / 'events.jsonl')
        events = output / 'events.jsonl'
    entries = jsonl(copied)
    if not entries or entries[0].get('type') != 'session':
        raise ValueError('Missing session header')
    header = entries[0]
    boundary = timestamp(header['timestamp'])
    branch = active_branch(entries[1:])
    fresh = [e for e in entries[1:] if timestamp(e['timestamp']) >= boundary]
    # Costs include fresh abandoned requests too. Context uses the active branch.
    assistants = [e for e in fresh if e.get('message', {}).get('role') == 'assistant']
    results = [e['message'] for e in fresh if e.get('message', {}).get('role') == 'toolResult']
    active_fresh = [e for e in branch if timestamp(e['timestamp']) >= boundary]
    users = [e for e in active_fresh if e.get('message', {}).get('role') == 'user']
    finals = [e for e in active_fresh if e.get('message', {}).get('role') == 'assistant']
    context = analyze(copied)
    parent = totals([e['message'].get('usage') for e in assistants])
    tools = totals([r['usage'] for r in results if 'usage' in r])
    helpers = totals([e.get('usage') for e in fresh
                      if e['type'] in ('usage', 'compaction', 'branch_summary') and 'usage' in e])
    issues, warnings = [], []
    if not parent['complete'] or not tools['complete'] or not helpers['complete']:
        issues.append('Missing or invalid usage records')
    calls = {}
    for e in assistants:
        for c in e['message'].get('content', []):
            if c.get('type') == 'toolCall':
                if c['id'] in calls:
                    issues.append('Duplicate tool-call ID')
                calls[c['id']] = {'name': c['name'], 'arguments': c.get('arguments'), 'source': 'parent'}
    for r in results:
        nested = r.get('nestedCalls', {})
        if nested.get('complete') is False:
            warnings.append('Nested metadata is partial; omitted arguments are not unfinished work')
            # Pi 0.99.2 only drops calls at its 256-call cap. A full event stream
            # recovers those IDs; argument omissions alone do not lose usage.
            if len(nested.get('calls', [])) >= 256 and events is None:
                issues.append('Capped nested-call inventory requires the event stream')
        for c in nested.get('calls', []):
            if c.get('status') == 'unfinished':
                issues.append('Unfinished nested tool call')
            calls[c['id']] = {**c, 'source': 'nested'}
    returned = {r['toolCallId'] for r in results}
    if any(c['source'] == 'parent' and i not in returned for i, c in calls.items()):
        issues.append('Unfinished parent tool calls')
    records = {r['toolCallId']: r.get('details', {}) for r in results if r['toolName'] == 'profile_subagent_run'}
    event_rows = jsonl(events) if events and events.exists() else []
    for e in event_rows:
        if e.get('type') == 'tool_execution_end':
            call = calls.setdefault(e['toolCallId'], {'name': e['toolName'], 'source': 'event'})
            call['status'] = 'error' if e.get('isError') else 'ok'
            if e.get('toolName') == 'profile_subagent_run':
                records[e['toolCallId']] = e.get('result', {}).get('details', {})
        if e.get('type') == 'tool_execution_start':
            call = calls.setdefault(e['toolCallId'], {'name': e['toolName'], 'source': 'event'})
            call.setdefault('arguments', e.get('args'))
    requested_children = {i for i, c in calls.items() if c['name'] == 'profile_subagent_run'}
    children = []
    used_dirs = set()
    child_root = child_root.resolve()
    for call_id in sorted(requested_children):
        detail = records.get(call_id) or {}
        row = {'callId': call_id, 'status': detail.get('status', 'unknown')}
        children.append(row)
        try:
            directory = Path(detail['artifactDir']).resolve(strict=True)
            if not directory.is_relative_to(child_root) or directory == child_root or directory in used_dirs:
                raise ValueError('Child artifact outside approved root or reused')
            used_dirs.add(directory)
            dest = output / f'child-{len(children)}'
            dest.mkdir(mode=0o700)
            for name in ('input.json', 'messages.json', 'result.json', 'result.md'):
                source = directory / name
                if source.resolve(strict=True).parent != directory:
                    raise ValueError('Child artifact redirects outside its directory')
                copy_evidence(source, dest / name)
            child_input, result = load(dest / 'input.json'), load(dest / 'result.json')
            if child_input['parentSessionId'] != header['id']:
                raise ValueError('Child belongs to another parent session')
            child_messages = load(dest / 'messages.json')
            usage = totals([m.get('usage') for m in child_messages if m.get('role') == 'assistant'])
            row.update({'artifactDir': str(directory), 'profile': result.get('profile'),
                        'profileDigest': result.get('profileDigest'), 'model': result.get('model'),
                        'thinkingLevel': result.get('thinkingLevel'), 'usage': usage,
                        'status': result.get('status'), 'outputTruncated': detail.get('outputTruncated')})
            child_reported = cost(result.get('usage'))
            if usage['records'] == 0 and result.get('turns') == 0 and result.get('status') == 'failed':
                child_reported = 0  # Recorded setup failure, no child model request.
            token_match = usage['complete'] and all(
                all(type(m.get('usage', {}).get(k)) is int for m in child_messages if m.get('role') == 'assistant')
                and sum(m['usage'][k] for m in child_messages if m.get('role') == 'assistant') == (result.get('usage') or {}).get(k)
                for k in ('input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'))
            row['reconciled'] = (usage['complete'] and token_match and child_reported is not None
                                 and math.isclose(usage['known'], child_reported, abs_tol=1e-9)
                                 and result.get('usage') == detail.get('usage'))
            if not row['reconciled']:
                issues.append('Child accounting did not reconcile')
        except (ValueError, OSError, KeyError, TypeError, AttributeError) as error:
            row['error'] = str(error)
            issues.append('Missing/unusable child evidence; do not assume zero child cost')
    child_known = sum(c.get('usage', {}).get('known', 0) for c in children)
    enclosed_costs = Counter()
    for child in children:
        matches = [r for r in results if child['callId'] == r['toolCallId']
                   or child['callId'].startswith(r['toolCallId'] + '/')]
        if len(matches) != 1:
            issues.append(f'Missing or ambiguous enclosing tool usage: {child["callId"]}')
            continue
        enclosed_costs[matches[0]['toolCallId']] += child.get('usage', {}).get('known', 0)
    for r in results:
        required = enclosed_costs[r['toolCallId']]
        reported = cost(r.get('usage'))
        if required > 0 and (reported is None or required > reported + 1e-9):
            issues.append(f'Child usage exceeds or lacks enclosing tool usage: {r["toolCallId"]}')
    complete = bool(assistants) and parent['complete'] and tools['complete'] and helpers['complete'] and not issues
    if not context['completed']:
        complete = False
        issues.append('Incomplete parent response; recorded costs may omit interrupted requests')
    if events and not any(e.get('type') == 'agent_settled' for e in event_rows):
        complete = False
        issues.append('No settled event; cleanup or automatic work may be incomplete')
    sections, declarations, setups = {}, {}, []
    for e in branch:
        m = e.get('message', {})
        if m.get('role') == 'system':
            for key, value in m.get('sections', {}).items():
                if value is None:
                    sections.pop(key, None)
                else:
                    sections[key] = value
            for t in m.get('toolsRemoved', []):
                declarations.pop(t if isinstance(t, str) else t['name'], None)
            for t in m.get('toolsAdded', []):
                declarations[t['name']] = t
        if m.get('role') == 'assistant' and e in active_fresh:
            setups.append({'entryId': e['id'], 'model': m.get('model'), 'provider': m.get('provider'),
                           'sectionHashes': {k: signature(v) for k, v in sections.items()},
                           'toolsHash': signature(declarations), 'toolNames': sorted(declarations)})
    elapsed = (timestamp(finals[-1]['timestamp']) - timestamp(users[0]['timestamp'])).total_seconds() if finals and users else None
    known = parent['known'] + tools['known'] + helpers['known']
    result = {'metricRevision': 'experiment-metrics-v1',
              'metricCodeSha256': {name: digest(Path(__file__).with_name(name)) for name in
                                  ('experiments.py', 'experiment_metrics.py', 'context_usage.py')},
              'sessionId': header['id'],
              'completed': context['completed'], 'elapsedSeconds': elapsed,
              'parentRequests': len(assistants), 'parentCost': parent, 'toolCost': tools, 'helperCost': helpers,
              'childCostKnown': child_known, 'recordedCostKnown': known,
              'accountingComplete': complete, 'totalReportedCost': known if complete else None,
              'childCount': len(requested_children), 'children': children,
              'toolCallCounts': dict(Counter(c['name'] for c in calls.values())),
              'toolFailures': sorted({r['toolCallId'] for r in results if r.get('isError')}
                                     | {i for i, c in calls.items() if c.get('status') == 'error'}),
              'context': context, 'requestSetups': setups, 'issues': issues, 'warnings': warnings,
              'parentModelChanges': [e for e in branch if e['type'] in ('model_change', 'thinking_level_change')],
              'quality': 'unreviewed; completion and a child launch are not correctness',
              'accountingNote': 'Parent + top-level tool usage + helpers. Child artifacts cross-check tool usage; never add them again.',
              'filesSha256': {str(p.relative_to(output)): digest(p) for p in output.rglob('*') if p.is_file()}}
    save(output / 'metrics.json', result)
    save(output / 'calls.json', calls)
    return result
