import {Type, type TSchema} from 'typebox';
import {Check, Errors} from 'typebox/value';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {GithubOperationSchemas} from './github-read.ts';

// Child-only interfaces, all routed through the same authorized parent adapter.
// The public adapter/direct reader contract remains backward compatible.
const descriptions = {
  repositories: [
    'github_repositories',
    'Find up to five repositories with a focused query, not an organization inventory.',
  ],
  resolve: [
    'github_resolve',
    'Resolve a repository branch/tag to an immutable commit and assignment-local revision handle.',
  ],
  list: [
    'github_list_directory',
    'List one directory, not a file. Use directory="." for the root. Listing is shallow: twenty safe entries per page. Use optional literal case-sensitive nameContains for a known name, or returned nextPage only for a relevant unresolved lead. No automatic inventory.',
  ],
  search: [
    'github_search_directory',
    'Literal search of at most five direct files in ONE DIRECTORY, not a file path or recursive repository search. Use github_file for a known file.',
  ],
  file: [
    'github_file',
    'Read a regular UTF-8 FILE by path. limit is 1–40 lines (default 30), never more than 40. Prefer the smallest useful window.',
  ],
  history: [
    'github_history',
    'Read bounded history for a repository-relative path or root ".". No automatic rename following or proof of original introduction.',
  ],
  discussion: [
    'github_discussion',
    'Read one bounded mutable issue/pull/comment/review page. No attachments or independent execution verification.',
  ],
} as const;

export function githubChildTools(parent: ToolDefinition): ToolDefinition[] {
  return GithubOperationSchemas.map(schema => {
    const operation = schema.properties.operation.const;
    const [name, description] = descriptions[operation];
    const properties: Record<string, TSchema> = {...schema.properties};
    delete properties.operation;
    if (operation === 'list' || operation === 'search') {
      properties.directory = Type.String({
        minLength: 1,
        maxLength: 1024,
        description:
          'Directory only, repository-relative; "." means root. Not a file path.',
      });
      delete properties.path;
    }
    const parameters = Type.Object(properties, {additionalProperties: false});
    return {
      name,
      label: name,
      description:
        description +
        ('commit' in schema.properties
          ? ' Use revision OR commit, never both; omit both to pin the default head.'
          : '') +
        ' All calls share the assignment limits. Cite returned sourceId markers as [[S...]]. Parent permission/redaction hooks still apply. No arbitrary URLs or writes.',
      parameters,
      prepareArguments(args) {
        // Pi can coerce integers before execute (e.g. 7.9 -> 7). Reject raw
        // invalid input first; never silently change the requested ID/window.
        if (!Check(parameters, args)) {
          const errors = Errors(parameters, args)
            .slice(0, 3)
            .map(
              error =>
                `${error.instancePath.slice(0, 80) || 'arguments'}: ${error.message.slice(0, 160)}`,
            );
          throw new Error(`${name}: ${errors.join('; ')}`);
        }
        return args as Record<string, unknown>;
      },
      async execute(id, args, signal, update, ctx) {
        const canonical: Record<string, unknown> = {
          ...(args as Record<string, unknown>),
          operation,
        };
        if (operation === 'list' || operation === 'search') {
          canonical.path = canonical.directory;
          delete canonical.directory;
        }
        return parent.execute(id, canonical, signal, update, ctx);
      },
    };
  });
}

export const githubChildToolNames = Object.values(descriptions).map(
  ([name]) => name,
);
