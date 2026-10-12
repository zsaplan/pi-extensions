#!/usr/bin/env python3
"""Explicit, plan-driven Pi experiments. No scheduler or automatic verdicts."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SKIP = {'.git', 'node_modules', 'tmp', '__pycache__'}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def load(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f'Duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=pairs)


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected a nonempty string')
    return value


def ident(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', text(value)):
        raise ValueError(f'Invalid identifier: {value}')
    return value


def keys(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError(f'Expected fields {allowed}; required {required}')


def strings(value):
    if not isinstance(value, list):
        raise ValueError('Expected a string array')
    return [text(v) for v in value]


def snapshot(roots):
    result = {}
    for name in sorted(set(roots)):
        root = Path(name)
        if not root.exists():
            result[name] = None
            continue
        files = [root]
        if root.is_dir():
            files = []
            for parent, dirs, names in os.walk(root):
                dirs[:] = sorted(d for d in dirs if d not in SKIP)
                for d in dirs:
                    if (Path(parent) / d).is_symlink():
                        raise ValueError('Freeze resolved paths instead of directory symlinks')
                files.extend(Path(parent) / n for n in sorted(names))
        for path in files:
            if path.is_symlink() or not path.is_file():
                raise ValueError(f'Unsupported frozen input: {path}')
            result[str(path)] = digest(path)
            if len(result) > 20000:
                raise ValueError('Too many frozen files; narrow the inputs')
    return result


def prepare(source, output):
    raw = load(source)
    keys(raw, ['version', 'id', 'hypothesis', 'criterion', 'cli', 'common', 'cases', 'variants', 'trials'],
         ['version', 'id', 'hypothesis', 'criterion', 'cases', 'variants', 'trials'])
    if type(raw['version']) is not int or raw['version'] != 1:
        raise ValueError('Unsupported plan version')
    base = source.resolve().parent
    resolve = lambda p: (base / text(p)).resolve(strict=True)
    cli = strings(raw.get('cli', ['pi']))
    if len(cli) not in (1, 2):
        raise ValueError('cli must be an executable, optionally followed by a Pi CLI file')
    cli[0] = str(Path(shutil.which(cli[0]) or resolve(cli[0])).resolve(strict=True))
    if len(cli) == 2:
        cli[1] = str(resolve(cli[1]))
    roots = [str(source.resolve()), *cli, *(str(HERE / p) for p in ('experiments.py', 'experiment_metrics.py', 'context_usage.py'))]
    common = raw.get('common', {})
    options = ['extensions', 'tools', 'provider', 'model', 'thinking', 'timeoutSeconds', 'resources', 'inputs', 'environment']
    keys(common, options)
    for field in ('cases', 'variants'):
        if not isinstance(raw[field], dict) or not raw[field]:
            raise ValueError(f'{field} must be a nonempty object')
    if not isinstance(raw['trials'], list):
        raise ValueError('trials must be an array')
    variants = {}
    for name, variant in raw['variants'].items():
        ident(name)
        keys(variant, options)
        v = {**common, **variant}
        extensions = []
        for path in strings(common.get('extensions', [])) + strings(variant.get('extensions', [])):
            if path.startswith('builtin:'):
                extensions.append(path)
            else:
                actual = str(resolve(path))
                roots.append(actual)
                extensions.append(actual)
        if len(set(extensions)) != len(extensions):
            raise ValueError('Duplicate extensions; load each extension exactly once')
        v['extensions'] = extensions
        for field, default in [('provider', 'openai-codex'), ('model', 'gpt-6.1-sol'), ('thinking', 'medium')]:
            v[field] = text(v.get(field, default))
        if v['thinking'] not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
            raise ValueError('Invalid thinking level')
        if 'tools' in v:
            v['tools'] = strings(v['tools'])
            if any(not re.fullmatch(r'[\w.-]+', t) for t in v['tools']):
                raise ValueError('tools must be an explicit list of tool names')
        v['timeoutSeconds'] = v.get('timeoutSeconds', 600)
        if type(v['timeoutSeconds']) is not int or not 1 <= v['timeoutSeconds'] <= 3600:
            raise ValueError('timeoutSeconds must be an integer from 1 to 3600')
        v['resources'] = v.get('resources', 'isolated')
        if v['resources'] not in ('isolated', 'ambient'):
            raise ValueError('resources must be isolated or ambient')
        env = {'PI_OFFLINE': '1', 'PI_DISCORD_NOTIFY_ENABLED': 'false',
               **common.get('environment', {}), **variant.get('environment', {})}
        for key, value in env.items():
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or re.search(r'TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY', key, re.I):
                raise ValueError('Only non-secret environment overrides belong in plans')
            text(value)
        v['environment'] = env
        for p in strings(common.get('inputs', [])) + strings(variant.get('inputs', [])):
            roots.append(str(resolve(p)))
        v.pop('inputs', None)
        agent = Path(env.get('PI_CODING_AGENT_DIR', os.environ.get('PI_CODING_AGENT_DIR', '~/.pi/agent'))).expanduser()
        if not agent.is_absolute():
            raise ValueError('PI_CODING_AGENT_DIR must be absolute for reproducible artifact lookup')
        agent = agent.resolve()
        if 'PI_CODING_AGENT_DIR' in env:
            env['PI_CODING_AGENT_DIR'] = str(agent)
        v['childRoot'] = str(agent / 'profile-subagent-runs')
        roots.append(str(agent / 'settings.json'))  # Hash only; never copy credentials/settings.
        variants[name] = v
    cases = {}
    for name, case in raw['cases'].items():
        ident(name)
        keys(case, ['cwd', 'prompt', 'authorization', 'inputs'], ['cwd', 'prompt', 'authorization'])
        cwd = resolve(case['cwd'])
        if not cwd.is_dir():
            raise ValueError('Case cwd must be a directory')
        roots.append(str(cwd / '.pi/settings.json'))
        files = [resolve(case[k]) for k in ('prompt', 'authorization')]
        roots.extend(str(p) for p in files)
        roots.extend(str(resolve(p)) for p in strings(case.get('inputs', [])))
        cases[name] = {'cwd': str(cwd), 'prompt': text(files[0].read_text()), 'authorization': text(files[1].read_text())}
    trials = []
    for trial in raw['trials']:
        keys(trial, ['id', 'case', 'variant'], ['id', 'case', 'variant'])
        ident(trial['id'])
        if trial['case'] not in cases or trial['variant'] not in variants:
            raise ValueError('Unknown trial case/variant')
        trials.append(trial)
    if not trials or len({t['id'] for t in trials}) != len(trials):
        raise ValueError('Provide unique trial IDs in explicit run order')
    output = output.resolve()
    for r in roots:
        path = Path(r)
        if path.is_dir() and output.is_relative_to(path) and not set(output.relative_to(path).parts) & SKIP:
            raise ValueError('Evidence directory would modify frozen inputs; use an excluded tmp directory')
    frozen = snapshot(roots)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    plan = {'version': 1, 'id': ident(raw['id']), 'hypothesis': text(raw['hypothesis']),
            'criterion': text(raw['criterion']), 'createdAt': now(), 'python': sys.version,
            'cli': cli, 'cases': cases, 'variants': variants, 'trials': trials,
            'roots': sorted(set(roots)), 'frozen': frozen,
            'limits': ['Hashes cover declared inputs, not all dependencies, inherited environment or live service state.',
                       'This plan is not authorization, a sandbox, a quality verdict or a hard dollar cap.']}
    plan['invocations'] = {t['id']: invocation(plan, t, output / 'runs' / t['id']) for t in trials}
    save(output / 'plan.json', plan)
    (output / 'plan.sha256').write_text(digest(output / 'plan.json') + '\n')
    save(output / 'source-plan.json', raw)
    (output / 'review.md').write_text('# Experiment review\n\n'
        'Execution is not a verdict. Fill after inspecting original evidence.\n\n'
        '- Hypothesis / predeclared criterion:\n- Coverage and quality by trial:\n'
        '- Scope/authority, failures and unperformed checks:\n- Cost/time/context and accounting gaps:\n'
        '- Confounds, reviewer and review method:\n- Result: supported / not supported / inconclusive\n'
        '- Decision: adopt / park / new hypothesis / stop\n- Ledger update / separate rollout approval:\n')
    print(output)


def verified_plan(group):
    if digest(group / 'plan.json') != (group / 'plan.sha256').read_text().strip():
        raise ValueError('Frozen plan was modified; prepare a new group')
    return load(group / 'plan.json')


def drift(plan):
    current = snapshot(plan['roots'])
    return [p for p in sorted(set(current) | set(plan['frozen'])) if current.get(p) != plan['frozen'].get(p)]


def invocation(plan, trial, run):
    v, case = plan['variants'][trial['variant']], plan['cases'][trial['case']]
    args = [*plan['cli'], '--mode', 'json', '--session', str(run / 'parent-session.jsonl'),
            '--no-extensions', '--provider', v['provider'], '--model', v['model'], '--thinking', v['thinking']]
    if v['resources'] == 'isolated':
        args += ['--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve']
    for extension in v['extensions']:
        args += ['-e', extension]
    if 'tools' in v:
        args += ['--tools', ','.join(v['tools'])] if v['tools'] else ['--no-tools']
    args += ['--append-system-prompt', str(run / 'authorization.md'), '--', case['prompt']]
    return args


def stop_process(process):
    if process.poll() is not None:
        return False
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
        return False
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        return True


def run_trial(group, name):
    plan = verified_plan(group)
    trial = next((t for t in plan['trials'] if t['id'] == name), None)
    if trial is None:
        raise ValueError('Unknown trial ID')
    # A group lock prevents accidental concurrent arms, not machine-wide scheduling.
    lock = group / '.running'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(fd, json.dumps({'pid': os.getpid(), 'trial': name, 'startedAt': now()}).encode())
    os.close(fd)
    try:
        for earlier in plan['trials'][:plan['trials'].index(trial)]:
            if not (group / 'runs' / earlier['id'] / 'execution.json').exists():
                raise ValueError('Run trials in the frozen order; previous trial is absent/incomplete')
        run = group / 'runs' / name
        run.mkdir(parents=True, exist_ok=False, mode=0o700)
        v, case = plan['variants'][trial['variant']], plan['cases'][trial['case']]
        args = invocation(plan, trial, run)
        record = {'trial': trial, 'startedAt': now(), 'cwd': case['cwd'], 'args': args,
                  'environmentOverrides': v['environment'], 'status': 'starting'}
        save(run / 'start.json', record)
        try:
            changed = drift(plan)
            if changed:
                raise ValueError(f'Frozen inputs changed: {changed}')
            (run / 'prompt.md').write_text(case['prompt'])
            (run / 'authorization.md').write_text(case['authorization'].replace('{{run}}', str(run)))
            env = {**os.environ, 'PI_OFFLINE': '1', 'PI_DISCORD_NOTIFY_ENABLED': 'false', **v['environment']}
            print(f'Running {name}; evidence: {run}', flush=True)
            with (run / 'events.jsonl').open('xb') as stdout, (run / 'stderr.log').open('xb') as stderr:
                process = subprocess.Popen(args, cwd=case['cwd'], env=env, stdin=subprocess.DEVNULL,
                                           stdout=stdout, stderr=stderr, start_new_session=True)
                record['launched'] = True
                try:
                    save(run / 'process.json', {'pid': process.pid, 'startedAt': now()})
                    record['exitCode'] = process.wait(timeout=v['timeoutSeconds'])
                    record['status'] = 'exited'
                except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                    record['status'] = 'timed-out' if isinstance(error, subprocess.TimeoutExpired) else 'cancelled'
                    record['forcedKill'] = stop_process(process)
                    record['exitCode'] = process.returncode
                finally:
                    # An evidence-write error must not leave a paid CLI running.
                    stop_process(process)
            record['processStatus'] = record['status']
            record['changedInputs'] = drift(plan)
            if record['changedInputs']:
                record['status'] = 'invalid-drift'
        except (OSError, ValueError) as error:
            record['status'] = 'invalid' if record.get('launched') else 'blocked'
            record['error'] = str(error)
        record['finishedAt'] = now()
        record['filesSha256'] = {p.name: digest(p) for p in run.iterdir() if p.is_file()}
        save(run / 'execution.json', record)
        print(json.dumps(record, indent=2))
        return 0 if record['status'] == 'exited' and record['exitCode'] == 0 else 1
    finally:
        lock.unlink()


def summarize(group):
    from experiment_metrics import measure
    if (group / '.running').exists():
        raise ValueError('Group is running or has an unresolved lock; do not read partial evidence')
    plan = verified_plan(group)
    dest = Path(tempfile.mkdtemp(prefix='summary-', dir=group))
    results = []
    for trial in plan['trials']:
        run = group / 'runs' / trial['id']
        execution = None
        try:
            if (run / 'execution.json').exists():
                execution = load(run / 'execution.json')
            elif (run / 'start.json').exists():
                execution = {**load(run / 'start.json'), 'status': 'unfinished-runner'}
        except (ValueError, OSError) as error:
            execution = {'status': 'unreadable-execution-record', 'error': str(error)}
        row = {'trial': trial, 'execution': execution, 'quality': 'unreviewed'}
        changed = []
        for name, expected in (execution or {}).get('filesSha256', {}).items():
            path = run / name
            if path.name != name or path.is_symlink() or not path.is_file() or digest(path) != expected:
                changed.append(name)
        if changed:
            row['measurementError'] = f'Recorded evidence changed: {changed}'
        elif (run / 'parent-session.jsonl').exists():
            try:
                row['metrics'] = measure(run / 'parent-session.jsonl', dest / trial['id'],
                                         Path(plan['variants'][trial['variant']]['childRoot']),
                                         run / 'events.jsonl')
            except (ValueError, OSError, KeyError) as error:
                row['measurementError'] = str(error)
        else:
            row['measurementError'] = 'No recorded session; cost/outcome unknown, not zero'
        if 'metrics' in row:
            v, m = plan['variants'][trial['variant']], row['metrics']
            row['configurationIssues'] = []
            if any(s.get('provider') != v['provider'] or s.get('model') != v['model'] for s in m['requestSetups']):
                row['configurationIssues'].append('Observed parent model differs from the plan')
            levels = [e.get('thinkingLevel') for e in m['parentModelChanges'] if e['type'] == 'thinking_level_change']
            if not levels or any(level != v['thinking'] for level in levels):
                row['configurationIssues'].append('Parent thinking level missing or different')
            if m['context']['newUserMessageCount'] != 1:
                row['configurationIssues'].append('Expected exactly one fresh user request')
        results.append(row)
    save(dest / 'summary.json', {'hypothesis': plan['hypothesis'], 'criterion': plan['criterion'],
                                 'createdAt': now(), 'results': results, 'verdict': 'human review required'})
    lines = ['# Experiment summary', '', 'Quality and coverage require human review; no automatic winner.', '',
             '| Trial | Execution | Parent complete | Seconds | Total reported cost | Peak parent input | Child calls |',
             '|---|---|---|---:|---:|---:|---:|']
    for row in results:
        m, e = row.get('metrics', {}), row.get('execution') or {}
        lines.append(f"| {row['trial']['id']} | {e.get('status', 'not run')} | {m.get('completed', 'unknown')} | "
                     f"{m.get('elapsedSeconds', 'unknown')} | {m.get('totalReportedCost', 'unknown')} | "
                     f"{m.get('context', {}).get('peakInputTokens', 'unknown')} | {m.get('childCount', 'unknown')} |")
    (dest / 'summary.md').write_text('\n'.join(lines) + '\n')
    print(dest)


def main():
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('plan', type=Path); p.add_argument('output', type=Path)
    p = sub.add_parser('run'); p.add_argument('group', type=Path); p.add_argument('trial')
    p = sub.add_parser('summarize'); p.add_argument('group', type=Path)
    p = sub.add_parser('measure'); p.add_argument('session', type=Path); p.add_argument('output', type=Path)
    p.add_argument('--events', type=Path)
    p.add_argument('--child-root', type=Path, default=Path(os.environ.get('PI_CODING_AGENT_DIR', '~/.pi/agent')).expanduser() / 'profile-subagent-runs')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            prepare(args.plan, args.output)
        elif args.command == 'run':
            return run_trial(args.group.resolve(), args.trial)
        elif args.command == 'summarize':
            summarize(args.group.resolve())
        else:
            from experiment_metrics import measure
            print(json.dumps(measure(args.session.resolve(), args.output.resolve(), args.child_root.resolve(), args.events), indent=2))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
