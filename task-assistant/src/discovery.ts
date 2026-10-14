import path from 'node:path';
import {
  absent,
  atomicJson,
  identifier,
  readJson,
  StoreError,
  type Inbox,
  type TaskStore,
} from './store.ts';

export interface DiscoveryOptions {
  mentionGroup?: string;
  watchChannel?: string;
}

export function discoveryOptions(
  values: Map<string, string>,
): DiscoveryOptions {
  const group = values.get('--mention-group');
  const channel = values.get('--watch-channel');
  return {
    ...(group === undefined
      ? {}
      : {mentionGroup: identifier(group, /^S[A-Z0-9]+$/)}),
    ...(channel === undefined
      ? {}
      : {watchChannel: identifier(channel, /^[CG][A-Z0-9]+$/)}),
  };
}

export async function requireDiscoveryOptions(
  store: TaskStore,
  options: DiscoveryOptions,
): Promise<void> {
  try {
    const saved = (await readJson(
      path.join(store.root, 'intake', 'discovery.json'),
    )) as {
      schema_version: number;
      scope: {mention_group: string | null; watch_channel: string | null};
    };
    if (
      saved.schema_version !== 1 ||
      saved.scope?.mention_group !== (options.mentionGroup ?? null) ||
      saved.scope?.watch_channel !== (options.watchChannel ?? null)
    )
      throw new StoreError('discovery_scope_mismatch');
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

// Added discovery sources are an explicit, durable operator choice, not model authority.
export async function bindDiscovery(
  store: TaskStore,
  selected: Inbox,
  options: DiscoveryOptions,
  now: number,
): Promise<number | undefined> {
  const file = path.join(store.root, 'intake', 'discovery.json');
  const scope = {
    workspace_id: selected.workspace_id,
    owner_user_id: selected.owner_user_id,
    mention_group: options.mentionGroup ?? null,
    watch_channel: options.watchChannel ?? null,
  };
  try {
    const saved = (await readJson(file)) as {
      schema_version: number;
      scope: unknown;
      since: number;
    };
    if (
      saved.schema_version !== 1 ||
      JSON.stringify(saved.scope) !== JSON.stringify(scope) ||
      !Number.isSafeInteger(saved.since) ||
      saved.since <= 0
    )
      throw new StoreError('discovery_scope_mismatch');
    return saved.since;
  } catch (error) {
    if (!absent(error)) throw error;
  }
  if (!options.mentionGroup && !options.watchChannel) return undefined;
  store.assertOwner();
  await atomicJson(file, {schema_version: 1, scope, since: now});
  return now;
}

export function literalMention(
  text: string,
  owner: string,
  group: string | undefined,
  origin: 'search' | 'conversation',
): boolean {
  if (text.includes(`<@${owner}>`)) return true;
  if (!group) return false;
  // Slack search represents a user group as <@S...>; conversations use <!subteam^S...>.
  return (
    (origin === 'search' && text.includes(`<@${group}>`)) ||
    new RegExp(`<!subteam\\^${group}(?:\\|[^>]+)?>`).test(text)
  );
}
