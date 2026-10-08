import {Type} from 'typebox';
import {Check} from 'typebox/value';
import {loadCatalog, profilesRoot} from './profiles.ts';
import {resolve} from 'node:path';

export const SearchSchema = Type.Object(
  {
    query: Type.String({minLength: 1, maxLength: 2048}),
    limit: Type.Optional(Type.Integer({minimum: 1, maximum: 5})),
  },
  {additionalProperties: false},
);

export function prepareSearchArguments(args: unknown) {
  if (!Check(SearchSchema, args) || !args.query.trim())
    throw new Error(
      'Provide a nonblank query up to 2,048 characters and an integer limit from 1 to 5.',
    );
  return args;
}

const stopWords = new Set(
  'a an and are as at be by can for from help i in is it of on or please review task that the these this to with'.split(
    ' ',
  ),
);
function tokens(value: string) {
  return new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      t => !stopWords.has(t),
    ),
  );
}

export async function searchProfiles(
  query: string,
  limit = 3,
  availableTools: readonly string[] = [],
) {
  prepareSearchArguments({query, limit});
  const {profiles, diagnostics} = await loadCatalog();
  const terms = tokens(query);
  const ranked = profiles
    .map(({manifest, digest}) => {
      const fields = {
        id: tokens(manifest.id),
        tags: tokens((manifest.tags ?? []).join(' ')),
        description: tokens(manifest.description),
      };
      const matches = Object.entries(fields).flatMap(([field, words]) =>
        [...terms].filter(term => words.has(term)).map(term => ({field, term})),
      );
      const score = matches.reduce(
        (sum, m) => sum + (m.field === 'id' ? 4 : m.field === 'tags' ? 2 : 1),
        0,
      );
      const exact = query.trim().toLowerCase() === manifest.id;
      const requiredTools = [...manifest.builtinTools, ...manifest.parentTools];
      return {
        exact,
        score,
        candidate: {
          id: manifest.id,
          description: manifest.description,
          matches,
          source: {kind: 'bundled', path: resolve(profilesRoot, manifest.id)},
          digest,
          requiredTools,
          unavailableTools: requiredTools.filter(
            name => !availableTools.includes(name),
          ),
        },
      };
    })
    .filter(r => r.exact || r.score > 0)
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        (a.candidate.id < b.candidate.id
          ? -1
          : a.candidate.id > b.candidate.id
            ? 1
            : 0),
    );
  const result = {
    candidates: ranked.slice(0, limit).map(r => r.candidate),
    matchedCandidates: ranked.length,
    diagnostics: diagnostics.slice(0, 10),
    omittedCandidates: Math.max(0, ranked.length - limit),
    omittedDiagnostics: Math.max(0, diagnostics.length - 10),
    outputTruncated: diagnostics.length > 10,
    availabilityMeaning:
      'Callable in this parent, not verified credentials or connectivity.',
  };
  while (JSON.stringify(result).length > 24000) {
    result.outputTruncated = true;
    if (result.diagnostics.length) {
      result.diagnostics.pop();
      result.omittedDiagnostics++;
    } else {
      result.candidates.pop();
      result.omittedCandidates++;
    }
  }
  return result;
}
