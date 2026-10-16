import {randomBytes} from 'node:crypto';

type Value = Record<string, unknown>;
type Source = {id: string; citation: string; observationId: string};
type Revision = {repository: string; commit: string};
const object = (value: unknown): value is Value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const immutable = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

// Only accept() retains mappings, after the normal parent hooks and packet bound.
export function createGithubReferences() {
  const prefix = randomBytes(6).toString('hex');
  const sources = new Map<string, Source>();
  const revisions = new Map<string, Revision>();
  let nextSource = 0,
    nextRevision = 0;

  function entries(value: Value): Value[] {
    return [
      value,
      ...['items', 'matches'].flatMap(key =>
        Array.isArray(value[key]) ? value[key].filter(object) : [],
      ),
    ];
  }

  return {
    decorate(value: Value): Value {
      const copy = structuredClone(value);
      if (copy.status !== 'ok' || copy.credentialRedacted) return copy;
      for (const entry of entries(copy)) {
        if (
          typeof entry.citation === 'string' &&
          entry.citation.startsWith('https://github.com/')
        )
          entry.sourceId = `S${prefix}-${++nextSource}`;
        if (typeof copy.repository === 'string' && immutable(entry.commit)) {
          const known = [...revisions].find(
            ([, r]) =>
              r.repository === (copy.repository as string).toLowerCase() &&
              r.commit === entry.commit,
          );
          entry.revisionHandle = known?.[0] ?? `R${prefix}-${++nextRevision}`;
        }
      }
      return copy;
    },
    accept(value: Value) {
      if (value.status !== 'ok' || typeof value.observationId !== 'string')
        return;
      for (const entry of entries(value)) {
        if (
          typeof entry.sourceId === 'string' &&
          entry.sourceId.startsWith(`S${prefix}-`) &&
          typeof entry.citation === 'string'
        )
          sources.set(entry.sourceId, {
            id: entry.sourceId,
            citation: entry.citation,
            observationId: value.observationId,
          });
        if (
          typeof value.repository === 'string' &&
          typeof entry.revisionHandle === 'string' &&
          entry.revisionHandle.startsWith(`R${prefix}-`) &&
          immutable(entry.commit)
        )
          revisions.set(entry.revisionHandle, {
            repository: value.repository.toLowerCase(),
            commit: entry.commit,
          });
      }
    },
    resolve(input: unknown): unknown {
      if (!object(input) || !('revision' in input)) return input;
      const revision =
        typeof input.revision === 'string'
          ? revisions.get(input.revision)
          : undefined;
      if (
        !revision ||
        'commit' in input ||
        typeof input.repository !== 'string' ||
        input.repository.toLowerCase() !== revision.repository ||
        !['file', 'list', 'search', 'history'].includes(String(input.operation))
      )
        throw new Error(
          'Unknown, conflicting or wrong-repository revision handle; use a revision returned in this assignment.',
        );
      const args: Value = {...input, commit: revision.commit};
      delete args.revision;
      return args;
    },
    render(report: string) {
      const used = new Map<string, Source>();
      const issues: string[] = [];
      let issueCount = 0;
      const problem = (reason: string) => {
        issueCount++;
        if (issues.length < 20) issues.push(reason);
      };
      // Validate raw URLs before rendering our own links. Exact observed URLs
      // remain supported for older hosts; invented subranges are not repaired.
      const byCitation = new Map(
        [...sources.values()].map(s => [s.citation, s]),
      );
      for (const match of report.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
        let url = match[0];
        // Markdown/prose punctuation is not part of the target. Prefer an exact
        // match first so legitimate parentheses inside paths remain supported.
        while (!byCitation.has(url) && /[)\].,;:!?]$/.test(url))
          url = url.slice(0, -1);
        const source = byCitation.get(url);
        if (source) used.set(source.id, source);
        else problem('Unobserved URL in report: ' + url.slice(0, 240));
      }
      for (const match of report.matchAll(/\]\(([^)\r\n]*)\)/g))
        if (!/^<?https?:\/\//i.test(match[1].trim()))
          problem('Unsupported link target; use an observed source marker.');
      const output = report.replace(
        /\[\[([SR][^\]\r\n]{0,100})\]\]/g,
        (_, id: string) => {
          const source = sources.get(id);
          if (!source) {
            problem('Unknown or unavailable source reference: ' + id);
            return '[unsupported source]';
          }
          used.set(id, source);
          return `[${id}](<${source.citation}>)`;
        },
      );
      if (/\[\[[SR]/.test(output))
        problem('Malformed source reference marker.');
      if (output.length > 24000)
        problem(
          'Rendered references exceed the existing 24000-character report bound.',
        );
      return {
        output: issues.length
          ? 'Reference validation failed. The original unverified report is preserved in result.json; inspect referenceValidation and sourceEvidence. No corrected citations were guessed.'
          : output,
        referenceValidation: {
          status: issues.length
            ? 'invalid'
            : used.size
              ? 'valid'
              : 'unreferenced',
          scope:
            'Reference identity only; claims and research completeness remain unverified.',
          issues,
          omittedIssues: issueCount - issues.length,
          sourceIds: [...used.keys()],
        },
      };
    },
  };
}
