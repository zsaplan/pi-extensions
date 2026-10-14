import {createHash} from 'node:crypto';

export const snapshotContract = 'json-structural-v1';
const maxBytes = 32768;
export const maxSnapshotReportBytes = 16384;
type Descriptor = {type: string; value?: string | number | boolean | null};
type Node = {descriptor: Descriptor; startLine: number; endLine: number};
type Side = Node | null;
export type Change = {pointer: string; before: Side; after: Side};
export type SnapshotReport = {
  contract: string;
  scope: string;
  before: {requestedPath: string; sha256: string};
  after: {requestedPath: string; sha256: string};
  counts: {
    beforeNodes: number;
    afterNodes: number;
    changed: number;
    unchanged: number;
  };
  changes: Change[];
  inventorySha256: string;
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const escaped = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const descriptor = (v: unknown): Descriptor =>
  v === null
    ? {type: 'null', value: null}
    : Array.isArray(v)
      ? {type: 'array'}
      : typeof v === 'object'
        ? {type: 'object'}
        : {type: typeof v, value: v as string | number | boolean};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// Native JSON validates grammar. This second pass preserves source locations
// and rejects duplicate decoded keys before any collapsed object is trusted.
function sourceNodes(text: string): Map<string, Node> {
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new Error('Snapshot exceeds 32 KiB.');
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('Snapshot is not strict JSON.');
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root))
    throw new Error('Snapshot root must be an object.');
  const nodes = new Map<string, Node>();
  let at = 0,
    count = 0;
  const skip = () => {
    while (/[\t\n\r ]/.test(text[at] ?? 'x')) at++;
  };
  const string = () => {
    const match = /^"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/.exec(
      text.slice(at),
    );
    if (!match) throw new Error('Invalid JSON string.');
    at += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const visit = (pointer: string, depth: number) => {
    if (depth > 32 || ++count > 2000)
      throw new Error('Snapshot depth/node limit exceeded.');
    skip();
    const start = at;
    let d: Descriptor;
    if (text[at] === '{') {
      d = {type: 'object'};
      at++;
      skip();
      const keys = new Set<string>();
      while (text[at] !== '}') {
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate decoded object key.');
        keys.add(key);
        skip();
        at++;
        visit(`${pointer}/${escaped(key)}`, depth + 1);
        skip();
        if (text[at] !== ',') break;
        at++;
        skip();
      }
      at++;
    } else if (text[at] === '[') {
      d = {type: 'array'};
      at++;
      skip();
      let index = 0;
      while (text[at] !== ']') {
        visit(`${pointer}/${index++}`, depth + 1);
        skip();
        if (text[at] !== ',') break;
        at++;
        skip();
      }
      at++;
    } else if (text[at] === '"') d = {type: 'string', value: string()};
    else {
      const token =
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          text.slice(at),
        )?.[0];
      if (!token) throw new Error('Invalid JSON scalar.');
      at += token.length;
      const value: unknown = JSON.parse(token);
      if (
        typeof value === 'number' &&
        (!Number.isSafeInteger(value) || /[.eE]/.test(token))
      )
        throw new Error('Only safe integer literals are supported.');
      d = descriptor(value);
    }
    nodes.set(pointer, {
      descriptor: d,
      startLine: text.slice(0, start).split('\n').length,
      endLine: text.slice(0, at).split('\n').length,
    });
  };
  visit('', 0);
  skip();
  if (at !== text.length) throw new Error('Unconsumed snapshot content.');
  return nodes;
}

// Independent enumeration over native JSON values (not the generator's map).
// Both passes still share the declared contract; external oracle fixtures matter.
function nativeInventory(text: string) {
  const result = new Map<string, Descriptor>();
  const visit = (value: unknown, path: string) => {
    result.set(path, descriptor(value));
    if (value !== null && typeof value === 'object')
      for (const [key, child] of Object.entries(value))
        visit(child, `${path}/${escaped(key)}`);
  };
  visit(JSON.parse(text), '');
  return result;
}

export function validateSnapshotReport(
  report: SnapshotReport,
  before: string,
  after: string,
  beforePath: string,
  afterPath: string,
) {
  const oldNodes = sourceNodes(before),
    newNodes = sourceNodes(after);
  const oldValues = nativeInventory(before),
    newValues = nativeInventory(after);
  const expected = new Set([...oldValues.keys(), ...newValues.keys()]);
  let unchanged = 0;
  for (const path of [...expected])
    if (same(oldValues.get(path), newValues.get(path))) {
      expected.delete(path);
      unchanged++;
    }
  if (
    !same(
      Object.keys(report).sort(),
      [
        'contract',
        'scope',
        'before',
        'after',
        'counts',
        'changes',
        'inventorySha256',
      ].sort(),
    ) ||
    report.contract !== snapshotContract ||
    report.scope !== 'returned-read-observations-only' ||
    !same(report.before, {requestedPath: beforePath, sha256: hash(before)}) ||
    !same(report.after, {requestedPath: afterPath, sha256: hash(after)}) ||
    !same(report.counts, {
      beforeNodes: oldValues.size,
      afterNodes: newValues.size,
      changed: expected.size,
      unchanged,
    }) ||
    !Array.isArray(report.changes) ||
    report.changes.length !== expected.size ||
    expected.size > 128
  )
    throw new Error('Snapshot inventory metadata/coverage mismatch.');
  for (const change of report.changes) {
    if (
      !same(
        Object.keys(change).sort(),
        ['pointer', 'before', 'after'].sort(),
      ) ||
      !expected.delete(change.pointer) ||
      !same(change.before?.descriptor, oldValues.get(change.pointer)) ||
      !same(change.after?.descriptor, newValues.get(change.pointer)) ||
      !same(change.before, oldNodes.get(change.pointer) ?? null) ||
      !same(change.after, newNodes.get(change.pointer) ?? null)
    )
      throw new Error(
        'Snapshot inventory value, pointer, span or duplicate mismatch.',
      );
  }
  if (
    expected.size ||
    report.inventorySha256 !== hash(JSON.stringify(report.changes))
  )
    throw new Error('Snapshot inventory hash/coverage mismatch.');
  if (
    Buffer.byteLength(JSON.stringify(report), 'utf8') > maxSnapshotReportBytes
  )
    throw new Error(
      'Snapshot report exceeds 16 KiB; no complete report returned.',
    );
}

export function compareSnapshots(
  before: string,
  after: string,
  beforePath: string,
  afterPath: string,
): SnapshotReport {
  const oldNodes = sourceNodes(before),
    newNodes = sourceNodes(after);
  const paths = [...new Set([...oldNodes.keys(), ...newNodes.keys()])].sort();
  const changes: Change[] = [];
  let unchanged = 0;
  for (const pointer of paths) {
    const old = oldNodes.get(pointer),
      current = newNodes.get(pointer);
    if (same(old?.descriptor, current?.descriptor)) unchanged++;
    else changes.push({pointer, before: old ?? null, after: current ?? null});
  }
  const report = {
    contract: snapshotContract,
    scope: 'returned-read-observations-only',
    before: {requestedPath: beforePath, sha256: hash(before)},
    after: {requestedPath: afterPath, sha256: hash(after)},
    counts: {
      beforeNodes: oldNodes.size,
      afterNodes: newNodes.size,
      changed: changes.length,
      unchanged,
    },
    changes,
    inventorySha256: hash(JSON.stringify(changes)),
  };
  validateSnapshotReport(report, before, after, beforePath, afterPath);
  return report;
}
