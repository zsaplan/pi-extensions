import {createHash} from 'node:crypto';
import {Type, type Static} from 'typebox';
import {Check} from 'typebox/value';

const text = Type.String({minLength: 1, maxLength: 1024});
const shaSchema = Type.String({pattern: '^[a-f0-9]{40}$'});
const common = {repository: text, commit: Type.Optional(shaSchema), path: text};
export const GithubReadSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal('repositories'),
      query: Type.String({
        minLength: 1,
        maxLength: 100,
        description:
          'Focused repository search, e.g. platform org:example. Token access only; not an organization inventory.',
      }),
      page: Type.Optional(Type.Integer({minimum: 1, maximum: 2})),
    },
    {additionalProperties: false},
  ),
  Type.Object(
    {
      operation: Type.Literal('resolve'),
      repository: text,
      ref: Type.Optional(Type.String({minLength: 1, maxLength: 200})),
    },
    {additionalProperties: false},
  ),
  Type.Object(
    {...common, operation: Type.Literal('list')},
    {additionalProperties: false},
  ),
  Type.Object(
    {
      ...common,
      operation: Type.Literal('search'),
      term: Type.String({minLength: 1, maxLength: 100}),
    },
    {additionalProperties: false},
  ),
  Type.Object(
    {
      ...common,
      operation: Type.Literal('file'),
      start: Type.Optional(Type.Integer({minimum: 1, maximum: 100000})),
      limit: Type.Optional(Type.Integer({minimum: 1, maximum: 40})),
    },
    {additionalProperties: false},
  ),
  Type.Object(
    {
      ...common,
      operation: Type.Literal('history'),
      path: Type.String({
        minLength: 1,
        maxLength: 1024,
        description:
          'Repository-relative path. Token access also permits root "."; grant access requires a granted path or directory root. Folder history can include unrelated changes; page/date limits still apply.',
      }),
      page: Type.Optional(Type.Integer({minimum: 1, maximum: 2})),
    },
    {additionalProperties: false},
  ),
  Type.Object(
    {
      operation: Type.Literal('discussion'),
      repository: text,
      number: Type.Integer({minimum: 1, maximum: 10000000}),
      kind: Type.Union(
        ['issue', 'pull', 'comments', 'reviews', 'review-comments'].map(v =>
          Type.Literal(v),
        ),
      ),
      page: Type.Optional(Type.Integer({minimum: 1, maximum: 2})),
    },
    {additionalProperties: false},
  ),
]);
export type GithubReadArgs = Static<typeof GithubReadSchema>;
export interface RepositoryGrant {
  repository: string;
  head: string;
  paths: string[]; // trailing slash = directory; otherwise one exact file
  history: boolean;
  since?: string;
  until?: string;
  discussions: number[];
}
export type RepositoryAccess = RepositoryGrant[] | 'token';
export function validateRepositoryAccess(
  input: RepositoryAccess,
): RepositoryAccess {
  return input === 'token' ? input : validateGrants(input);
}
export interface GithubTransport {
  token: (signal: AbortSignal) => Promise<string>;
  // Trusted host injection for offline fixtures; not exposed to model arguments.
  fetch?: typeof globalThis.fetch;
}
const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
type RequestFailure = {
  requestId: number;
  firstObservedAt: string;
  reused: boolean;
};
class BoundaryError extends Error {
  readonly status: 'refused' | 'unavailable';
  readonly requestFailure?: RequestFailure;
  constructor(
    message: string,
    status: 'refused' | 'unavailable' = 'refused',
    requestFailure?: RequestFailure,
  ) {
    super(message);
    this.status = status;
    this.requestFailure = requestFailure;
  }
}
function fail(message: string): never {
  throw new BoundaryError(message, 'unavailable');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('Unsupported GitHub response shape.');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value))
    fail('Unsupported GitHub object identity.');
  return value;
}
export const containsControl = (value: string) =>
  [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function pathIsSafe(path: string): boolean {
  return (
    path.length <= 1024 &&
    !/[\\%]/.test(path) &&
    !containsControl(path) &&
    path.split('/').every(p => p.length > 0 && p !== '.' && p !== '..')
  );
}
function sensitive(path: string): boolean {
  return /(^|\/)(\.git|\.ssh|\.aws|\.kube|\.npmrc|\.netrc|\.pypirc|\.env(?:\.[^/]*)?|id_rsa|id_ed25519)(\/|$)|(^|[/._-])(credentials?|secrets?|tokens?|passwords?|private[-_]?key)([/._-]|$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(
    path,
  );
}
export function validateGrants(input: RepositoryGrant[]): RepositoryGrant[] {
  if (!Array.isArray(input) || !input.length || input.length > 2)
    throw new Error('Provide one or two explicit repository grants.');
  const grants = structuredClone(input);
  for (const g of grants) {
    if (
      !g ||
      typeof g !== 'object' ||
      Object.keys(g).some(
        key =>
          ![
            'repository',
            'head',
            'paths',
            'history',
            'since',
            'until',
            'discussions',
          ].includes(key),
      ) ||
      typeof g.repository !== 'string' ||
      containsControl(g.repository) ||
      !repositoryPattern.test(g.repository) ||
      !shaPattern.test(g.head) ||
      typeof g.history !== 'boolean' ||
      !Array.isArray(g.paths) ||
      !g.paths.length ||
      g.paths.length > 4 ||
      g.paths.some(
        p =>
          typeof p !== 'string' ||
          !pathIsSafe(p.replace(/\/$/, '')) ||
          sensitive(p.replace(/\/$/, '')),
      ) ||
      !Array.isArray(g.discussions) ||
      g.discussions.length > 10 ||
      g.discussions.some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000000)
    )
      throw new Error('Invalid bounded GitHub grant.');
    for (const date of [g.since, g.until])
      if (
        date !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().replace('.000Z', 'Z') !== date)
      )
        throw new Error('Use explicit UTC history dates.');
    if (g.since && g.until && g.since > g.until)
      throw new Error('Invalid history date range.');
    g.repository = g.repository.toLowerCase();
  }
  if (new Set(grants.map(g => g.repository)).size !== grants.length)
    throw new Error('Duplicate repository grant.');
  return grants;
}
const encodePath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

export function createGithubReader(
  input: RepositoryAccess,
  transport: GithubTransport,
) {
  const access = validateRepositoryAccess(input);
  const tokenAccess = access === 'token';
  const grants: RepositoryGrant[] = access === 'token' ? [] : access;
  const known = new Map(grants.map(g => [g.repository, new Set([g.head])]));
  const trees = new Map<string, unknown>();
  const roots = new Map<string, string>();
  const credentials = new Set<string>();
  // Per-assignment only. Serialize identical in-flight requests; retain failures,
  // not successful mutable responses. Waiting callers cannot retry a failed GET.
  const pendingRequests = new Map<string, Promise<void>>();
  const requestFailures = new Map<
    string,
    {reason: string; requestId: number; firstObservedAt: string}
  >();
  let requests = 0,
    bytes = 0,
    calls = 0,
    reusedFailures = 0;
  async function waitForRequest(pending: Promise<void>, signal: AbortSignal) {
    let abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        else void pending.then(resolve);
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async function get(
    g: RepositoryGrant | undefined,
    endpoint: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const key = g ? `repos/${g.repository}/${endpoint}` : endpoint;
    while (pendingRequests.has(key)) {
      await waitForRequest(pendingRequests.get(key)!, signal);
      signal.throwIfAborted();
    }
    const previous = requestFailures.get(key);
    if (previous) {
      reusedFailures++;
      throw new BoundaryError(
        `Prior identical request failed; no new HTTP request. ${previous.reason}`,
        'unavailable',
        {
          requestId: previous.requestId,
          firstObservedAt: previous.firstObservedAt,
          reused: true,
        },
      );
    }
    if (bytes >= 786432)
      fail(
        'Assignment response-byte budget exhausted; no further HTTP request.',
      );
    if (requests >= 50)
      fail('Assignment HTTP request limit reached; no retry.');
    const requestId = ++requests;
    let release!: () => void;
    pendingRequests.set(
      key,
      new Promise<void>(resolve => {
        release = resolve;
      }),
    );
    try {
      return await request(g, endpoint, signal);
    } catch (error) {
      const reason = signal.aborted
        ? 'GitHub request cancelled; no retry in this assignment.'
        : error instanceof BoundaryError
          ? error.message
          : 'GitHub transport/response unavailable; no retry. Raw errors are withheld.';
      const firstObservedAt = new Date().toISOString();
      requestFailures.set(key, {reason, requestId, firstObservedAt});
      throw new BoundaryError(reason, 'unavailable', {
        requestId,
        firstObservedAt,
        reused: false,
      });
    } finally {
      pendingRequests.delete(key);
      release();
    }
  }
  async function request(
    g: RepositoryGrant | undefined,
    endpoint: string,
    signal: AbortSignal,
  ) {
    const limited = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const token = await transport.token(limited);
    limited.throwIfAborted();
    if (
      typeof token !== 'string' ||
      token.length < 8 ||
      token.length > 4096 ||
      containsControl(token)
    )
      fail('GitHub credential unavailable.');
    credentials.add(token);
    // Another call may exhaust the shared budget while credentials are resolved.
    if (bytes >= 786432)
      fail(
        'Assignment response-byte budget exhausted; no further HTTP request.',
      );
    const response = await (transport.fetch ?? globalThis.fetch)(
      `https://api.github.com/${g ? `repos/${g.repository}/` : ''}${endpoint}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: limited,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404)
        fail(
          'GitHub returned 404: unavailable or inaccessible; absence is not established.',
        );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429
      )
        fail(`GitHub access/rate limit (${response.status}); no retry.`);
      fail(`GitHub request unavailable (${response.status}); no retry.`);
    }
    const reader = response.body?.getReader();
    if (!reader) fail('Empty GitHub response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        limited.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        bytes += part.value.byteLength;
        if (size > 131072 || bytes > 786432)
          fail('GitHub response byte budget exceeded; incomplete observation.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return {
      value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      next: /rel="next"/.test(response.headers.get('link') ?? ''),
    };
  }
  function allowed(g: RepositoryGrant, path: string, directory = false) {
    if (tokenAccess && directory && path === '') return true;
    if (!pathIsSafe(path) || sensitive(path)) return false;
    if (tokenAccess) return true;
    return g.paths.some(p =>
      p.endsWith('/')
        ? path.startsWith(p) || (directory && path === p.slice(0, -1))
        : !directory && path === p,
    );
  }
  async function tree(g: RepositoryGrant, id: string, signal: AbortSignal) {
    const key = `${g.repository}:${id}`;
    if (!trees.has(key)) {
      const data = record((await get(g, `git/trees/${id}`, signal)).value);
      if (
        sha(data.sha) !== id ||
        data.truncated !== false ||
        !Array.isArray(data.tree)
      )
        fail('Incomplete or mismatched GitHub tree; coverage unavailable.');
      trees.set(key, data.tree);
    }
    return (trees.get(key) as unknown[]).map(record);
  }
  async function root(g: RepositoryGrant, commit: string, signal: AbortSignal) {
    const key = `${g.repository}:${commit}`;
    if (!roots.has(key)) {
      const data = record(
        (await get(g, `git/commits/${commit}`, signal)).value,
      );
      if (sha(data.sha) !== commit) fail('GitHub commit identity mismatch.');
      roots.set(key, sha(record(data.tree).sha));
    }
    return roots.get(key)!;
  }
  async function lookup(
    g: RepositoryGrant,
    commit: string,
    path: string,
    signal: AbortSignal,
  ) {
    let id = await root(g, commit, signal);
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await tree(g, id, signal)).find(e => e.path === parts[i]);
      if (!entry)
        fail(
          'Path not found in the observed complete tree; no broader absence claim.',
        );
      if (i === parts.length - 1) return entry;
      if (entry.type !== 'tree' || entry.mode !== '040000')
        throw new BoundaryError(
          'Non-directory traversal, symlinks and submodules are refused.',
        );
      id = sha(entry.sha);
    }
    return fail('Path unavailable.');
  }
  async function resolveCommit(
    g: RepositoryGrant,
    ref: string | undefined,
    signal: AbortSignal,
  ) {
    if (ref !== undefined && (!ref.trim() || containsControl(ref)))
      throw new BoundaryError('Invalid GitHub reference.');
    const query = new URLSearchParams({per_page: '1'});
    if (ref !== undefined) query.set('sha', ref);
    const data = await get(g, `commits?${query}`, signal);
    if (!Array.isArray(data.value) || data.value.length !== 1)
      fail('Commit resolution unavailable; no pinned version established.');
    const item = record(data.value[0]),
      id = sha(item.sha);
    if (ref && shaPattern.test(ref) && ref !== id)
      fail('GitHub commit identity mismatch.');
    roots.set(
      `${g.repository}:${id}`,
      sha(record(record(item.commit).tree).sha),
    );
    known.get(g.repository)!.add(id);
    return id;
  }
  async function listing(
    g: RepositoryGrant,
    commit: string,
    path: string,
    signal: AbortSignal,
  ) {
    const entry =
      path === ''
        ? {type: 'tree', mode: '040000', sha: await root(g, commit, signal)}
        : await lookup(g, commit, path, signal);
    if (entry.type !== 'tree' || entry.mode !== '040000')
      throw new BoundaryError('List/search requires an approved directory.');
    const entries = (await tree(g, sha(entry.sha), signal)).filter(
      e =>
        typeof e.path === 'string' &&
        pathIsSafe(e.path) &&
        !e.path.includes('/'),
    );
    const childPath = (name: unknown) =>
      path ? `${path}/${name}` : String(name);
    const visible = entries.filter(
      e =>
        allowed(g, childPath(e.path), e.type === 'tree') &&
        ((e.type === 'tree' && e.mode === '040000') ||
          (e.type === 'blob' && ['100644', '100755'].includes(String(e.mode)))),
    );
    return {
      entries: visible.slice(0, 20).map(e => ({
        path: childPath(e.path),
        type: String(e.type),
        sha: sha(e.sha),
      })),
      omitted: entries.length - visible.slice(0, 20).length,
    };
  }
  async function contents(
    g: RepositoryGrant,
    commit: string,
    path: string,
    signal: AbortSignal,
    redact: (value: string) => string,
  ) {
    const entry = await lookup(g, commit, path, signal);
    if (
      entry.type !== 'blob' ||
      !['100644', '100755'].includes(String(entry.mode))
    )
      throw new BoundaryError(
        'Only regular files are readable; symlinks/submodules refused.',
      );
    if (typeof entry.size !== 'number' || entry.size > 32768)
      fail('File exceeds 32 KiB or size is unavailable.');
    const id = sha(entry.sha),
      data = record((await get(g, `git/blobs/${id}`, signal)).value);
    if (
      sha(data.sha) !== id ||
      data.encoding !== 'base64' ||
      typeof data.content !== 'string'
    )
      fail('Unsupported GitHub blob response.');
    const encoded = data.content.replace(/\n/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      fail('Invalid GitHub blob encoding.');
    const raw = Buffer.from(encoded, 'base64');
    if (
      raw.length !== entry.size ||
      data.size !== raw.length ||
      raw.length > 32768 ||
      createHash('sha1')
        .update(`blob ${raw.length}\0`)
        .update(raw)
        .digest('hex') !== id
    )
      fail('GitHub blob size/hash mismatch.');
    const body = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    if (body.includes('\0')) fail('Binary file observation unavailable.');
    // Redact complete values before clipping, so an excerpt cannot leak a prefix.
    const source = body.length ? redact(body).split('\n') : [];
    if (body.endsWith('\n')) source.pop();
    return {blob: id, lines: source};
  }
  function lines(source: string[], start: number, limit: number) {
    return source.slice(start - 1, start - 1 + limit).map((value, i) => ({
      line: start + i,
      text: value.slice(0, 300),
      truncated: value.length > 300,
    }));
  }
  async function operate(
    args: GithubReadArgs,
    signal: AbortSignal,
    redact: (value: string) => string,
  ): Promise<object> {
    const clean = (value: unknown) =>
      typeof value === 'string' ? redact(value) : '';
    const clip = (value: unknown, max: number) => clean(value).slice(0, max);
    if (args.operation === 'repositories') {
      if (!tokenAccess)
        throw new BoundaryError('Repository discovery requires token access.');
      if (!args.query.trim() || containsControl(args.query))
        throw new BoundaryError('Provide a focused repository search.');
      const page = args.page ?? 1;
      const query = new URLSearchParams({
        q: args.query,
        per_page: '5',
        page: String(page),
      });
      const data = await get(undefined, `search/repositories?${query}`, signal);
      const value = record(data.value);
      if (
        !Array.isArray(value.items) ||
        typeof value.incomplete_results !== 'boolean'
      )
        fail('Unsupported GitHub repository search response.');
      return {
        items: value.items.slice(0, 5).map(item => {
          const repo = record(item);
          if (
            typeof repo.full_name !== 'string' ||
            containsControl(repo.full_name) ||
            !repositoryPattern.test(repo.full_name)
          )
            fail('Unsupported GitHub repository identity.');
          const description = clean(repo.description);
          return {
            repository: repo.full_name.toLowerCase(),
            description: description.slice(0, 300),
            descriptionTruncated: description.length > 300,
            citation: `https://github.com/${repo.full_name.toLowerCase()}`,
          };
        }),
        coverage: {
          page,
          hasNext: data.next,
          earlierPagesNotObserved: page > 1,
          incompleteResults: value.incomplete_results,
          collectionLimited: value.items.length > 5,
          completeInventory: false,
          searchIndex: 'GitHub search results, not proof of absence or access',
        },
      };
    }
    if (
      containsControl(args.repository) ||
      !repositoryPattern.test(args.repository)
    )
      throw new BoundaryError('Invalid GitHub repository name.');
    const repository = args.repository.toLowerCase();
    let g = grants.find(g => g.repository === repository);
    if (!g && tokenAccess) {
      g = {repository, head: '', paths: [], history: true, discussions: []};
      grants.push(g);
      known.set(repository, new Set());
    }
    if (!g) throw new BoundaryError('Repository is outside the host grant.');
    const base = `https://github.com/${g.repository}`;
    if (args.operation === 'resolve') {
      if (!tokenAccess)
        throw new BoundaryError('Reference resolution requires token access.');
      const commit = await resolveCommit(g, args.ref, signal);
      return {
        commit,
        ref: args.ref ?? 'default branch',
        citation: `${base}/commit/${commit}`,
        coverage: {
          mutableRef: args.ref === undefined || !shaPattern.test(args.ref),
          instruction:
            'Use the returned commit for subsequent reads of this version.',
        },
      };
    }
    if (args.operation === 'discussion') {
      if (!tokenAccess && !g.discussions.includes(args.number))
        throw new BoundaryError('Discussion number is outside the host grant.');
      const page = args.page ?? 1;
      const endpoints = {
        issue: `issues/${args.number}`,
        pull: `pulls/${args.number}`,
        comments: `issues/${args.number}/comments`,
        reviews: `pulls/${args.number}/reviews`,
        'review-comments': `pulls/${args.number}/comments`,
      };
      const collection = !['issue', 'pull'].includes(args.kind);
      if (!collection && page !== 1)
        throw new BoundaryError('A single discussion has no page selector.');
      const data = await get(
        g,
        `${endpoints[args.kind]}${collection ? `?per_page=5&page=${page}` : ''}`,
        signal,
      );
      if (collection && !Array.isArray(data.value))
        fail('Unsupported GitHub discussion collection.');
      const values = (collection ? (data.value as unknown[]) : [data.value])
        .slice(0, 5)
        .map(record);
      const items = values.map(v => {
        if (!Number.isSafeInteger(v.id) || Number(v.id) < 1)
          fail('Unsupported GitHub discussion identity.');
        const anchor =
          args.kind === 'comments'
            ? `#issuecomment-${v.id}`
            : args.kind === 'reviews'
              ? `#pullrequestreview-${v.id}`
              : args.kind === 'review-comments'
                ? `#discussion_r${v.id}`
                : '';
        const title = clean(v.title),
          body = clean(v.body);
        return {
          id: v.id,
          title: title.slice(0, 200),
          titleTruncated: title.length > 200,
          body: body.slice(0, 1200),
          bodyTruncated: body.length > 1200,
          updatedAt: clip(v.updated_at ?? v.submitted_at, 40),
          citation: `${base}/${['pull', 'reviews', 'review-comments'].includes(args.kind) ? 'pull' : 'issues'}/${args.number}${anchor}`,
        };
      });
      return {
        items,
        coverage: {
          page,
          hasNext: data.next,
          earlierPagesNotObserved: page > 1,
          mutable: true,
          attachments: 'not read',
          collectionLimited: collection && (data.value as unknown[]).length > 5,
        },
      };
    }
    // History may address an explicitly granted directory root, not the parent
    // of an exact-file grant. Leave all other history spellings unchanged.
    const historyRoot =
      args.operation === 'history' &&
      (tokenAccess
        ? args.path === '.' || args.path.endsWith('/')
        : g.paths.some(
            p =>
              p.endsWith('/') &&
              (args.path === p || args.path === p.slice(0, -1)),
          ));
    const directory =
      args.operation === 'list' || args.operation === 'search' || historyRoot;
    // Remove only one slash; malformed paths are never broadly normalized.
    const path =
      tokenAccess && directory && args.path === '.'
        ? ''
        : directory
          ? args.path.replace(/\/$/, '')
          : args.path;
    if ((!path && args.path !== '.') || !allowed(g, path, directory))
      throw new BoundaryError(
        'Path is outside scope or is a prohibited sensitive path.',
      );
    const commit =
      args.commit ??
      (g.head || (g.head = await resolveCommit(g, undefined, signal)));
    if (!tokenAccess && !known.get(g.repository)!.has(commit))
      throw new BoundaryError(
        'Commit is not the pinned head or observed permitted history. Branch/tag resolution is not supported.',
      );
    if (args.operation === 'list')
      return {
        ...(await listing(g, commit, path, signal)),
        commit,
        coverage:
          'Shallow directory only; omitted entries may be unsafe, out of scope or over the 20-entry bound.',
      };
    if (args.operation === 'file') {
      const file = await contents(g, commit, args.path, signal, redact),
        start = args.start ?? 1;
      if (start > Math.max(1, file.lines.length))
        fail(
          'Requested line window is beyond the observed file; no line citation available.',
        );
      const selected = lines(file.lines, start, args.limit ?? 30);
      return {
        commit,
        path: args.path,
        blob: file.blob,
        lines: selected,
        citation: `${base}/blob/${commit}/${encodePath(args.path)}${selected.length ? `#L${start}-L${selected.at(-1)!.line}` : ''}`,
        coverage: {
          totalLines: file.lines.length,
          omittedLines: file.lines.length - selected.length,
          lineTextTruncated: selected.some(l => l.truncated),
        },
      };
    }
    if (args.operation === 'search') {
      const listingResult = await listing(g, commit, path, signal),
        candidates = listingResult.entries
          .filter(e => e.type === 'blob')
          .slice(0, 5);
      const checked: string[] = [],
        matches: object[] = [],
        unavailable: Array<{
          path: string;
          reason: string;
          requestFailure?: RequestFailure;
        }> = [];
      for (const entry of candidates) {
        try {
          const file = await contents(g, commit, entry.path, signal, redact);
          checked.push(entry.path);
          const hits = file.lines.flatMap((line, i) =>
            line.includes(args.term) ? [i + 1] : [],
          );
          if (hits.length)
            matches.push({
              path: entry.path,
              blob: file.blob,
              lines: hits.slice(0, 3).flatMap(n => lines(file.lines, n, 1)),
              omittedHits: Math.max(0, hits.length - 3),
              citation: `${base}/blob/${commit}/${encodePath(entry.path)}#L${hits[0]}`,
            });
        } catch (error) {
          signal.throwIfAborted();
          unavailable.push({
            path: entry.path,
            reason:
              error instanceof BoundaryError
                ? error.message
                : 'Transport or file observation unavailable; raw error withheld.',
            ...(error instanceof BoundaryError && error.requestFailure
              ? {requestFailure: error.requestFailure}
              : {}),
          });
        }
      }
      return {
        commit,
        matches,
        coverage: {
          checked,
          unavailable,
          completeRepositorySearch: false,
          nestedDirectoriesNotSearched: true,
          omittedEntries: listingResult.omitted,
          unsearchedListedFiles:
            listingResult.entries.filter(e => e.type === 'blob').length -
            candidates.length,
          maxFiles: 5,
          maxHitsPerFile: 3,
        },
      };
    }
    if (!g.history)
      throw new BoundaryError('History is not in the host grant.');
    const page = args.page ?? 1,
      query = new URLSearchParams({
        sha: commit,
        path,
        per_page: '10',
        page: String(page),
      });
    if (g.since) query.set('since', g.since);
    if (g.until) query.set('until', g.until);
    const data = await get(g, `commits?${query}`, signal);
    if (!Array.isArray(data.value))
      fail('Unsupported GitHub history response.');
    const items = data.value.slice(0, 10).map(value => {
      const c = record(value),
        id = sha(c.sha),
        meta = record(c.commit);
      if (!Array.isArray(c.parents) || c.parents.length > 8)
        fail('Unsupported commit parents.');
      const parents = c.parents.map(p => sha(record(p).sha));
      const message = clean(meta.message);
      return {
        commit: id,
        parents,
        message: message.slice(0, 500),
        messageTruncated: message.length > 500,
        date: clip(record(meta.committer).date, 40),
        citation: `${base}/commit/${id}`,
      };
    });
    for (const item of items) {
      known.get(g.repository)!.add(item.commit);
      item.parents.forEach(p => known.get(g.repository)!.add(p));
    }
    return {
      path,
      items,
      coverage: {
        directoryGrantRoot: !tokenAccess && historyRoot,
        page,
        hasNext: data.next,
        earlierPagesNotObserved: page > 1,
        collectionLimited: data.value.length > 10,
        since: g.since,
        until: g.until,
        renameFollowing: false,
        originalIntroductionVerified: false,
      },
    };
  }
  return {
    stats: () => ({calls, requests, responseBytes: bytes, reusedFailures}),
    async read(input: unknown, signal: AbortSignal) {
      signal.throwIfAborted();
      calls++;
      let credentialRedacted = false;
      const redact = (value: string) => {
        for (const credential of credentials) {
          if (value.includes(credential)) {
            value = value.split(credential).join('[REDACTED_CREDENTIAL]');
            credentialRedacted = true;
          }
        }
        return value;
      };
      let result: object;
      try {
        if (calls > 16)
          throw new BoundaryError('Assignment tool-call limit reached.');
        if (!Check(GithubReadSchema, input))
          throw new BoundaryError('Unsupported operation or arguments.');
        result = {
          status: 'ok',
          operation: input.operation,
          ...('repository' in input ? {repository: input.repository} : {}),
          ...(await operate(input, signal, redact)),
        };
      } catch (error) {
        signal.throwIfAborted();
        result =
          error instanceof BoundaryError
            ? {
                status: error.status,
                reason: error.message,
                ...(error.requestFailure
                  ? {requestFailure: error.requestFailure}
                  : {}),
              }
            : {
                status: 'unavailable',
                reason:
                  'GitHub transport/response unavailable; no retry. Raw errors are withheld.',
              };
      }
      let outcome: Record<string, unknown> = {
        ...result,
        observedAt: new Date().toISOString(),
      };
      // Also redact credentials in metadata, not just file/discussion text.
      let encoded = JSON.stringify(outcome);
      for (const credential of credentials) {
        const needle = JSON.stringify(credential).slice(1, -1);
        if (encoded.includes(needle)) {
          encoded = encoded.split(needle).join('[REDACTED_CREDENTIAL]');
          credentialRedacted = true;
        }
      }
      if (credentialRedacted)
        outcome = {...JSON.parse(encoded), credentialRedacted: true};
      if (Buffer.byteLength(JSON.stringify(outcome)) > 16384)
        outcome = {
          status: 'unavailable',
          reason: 'Observation exceeds 16 KiB; no partial source returned.',
          observedAt: new Date().toISOString(),
        };
      return outcome;
    },
  };
}
