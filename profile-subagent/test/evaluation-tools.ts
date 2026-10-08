import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const root = process.env.PROFILE_EVAL_WORKSPACE!;
  pi.on('tool_call', async event => {
    if (!['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
    try {
      const path =
        'path' in event.input && typeof event.input.path === 'string'
          ? event.input.path
          : '.';
      const actual = await realpath(resolve(root, path));
      const rel = relative(await realpath(root), actual);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
        throw new Error('outside fixture');
    } catch {
      return {
        block: true,
        reason: 'Evaluation permits only existing fixture files.',
      };
    }
    return undefined;
  });
  for (const name of [
    'bc_site_db_search_saved_queries',
    'bc_site_db_run_saved_query',
    'bc_site_db_query',
  ]) {
    pi.registerTool({
      name,
      label: name,
      description:
        'Synthetic read-only database fixture. Search returns no saved queries. Query returns the complete supplied fixture state, not SQL-engine results. Only fixture-site / test is allowed.',
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        id: Type.Optional(Type.String()),
        site: Type.Optional(Type.String()),
        environment: Type.Optional(Type.String()),
        sql: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(Type.Number()),
      }),
      async execute(_id, args) {
        if (name === 'bc_site_db_search_saved_queries')
          return {
            content: [{type: 'text', text: '{"queries":[]}'}],
            details: {synthetic: true},
          };
        if (name === 'bc_site_db_run_saved_query')
          throw new Error('No saved fixture queries exist.');
        if (args.site !== 'fixture-site' || args.environment !== 'test')
          throw new Error('Exact fixture-site / test scope required.');
        if (!/^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(args.sql ?? ''))
          throw new Error(
            'Read-only statements only; no SQL is actually executed.',
          );
        const text = await readFile(resolve(root, 'evidence/db.json'), 'utf8');
        return {content: [{type: 'text', text}], details: {synthetic: true}};
      },
    });
  }
}
