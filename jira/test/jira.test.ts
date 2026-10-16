import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {
  JiraClient,
  adfToText,
  createIssue,
  editComment,
  searchIssues,
  textToAdf,
  transitionIssue,
  type JiraApiCaller,
  type JiraRequestOptions,
} from '../src/jira.ts';

class RecordingClient implements JiraApiCaller {
  calls: Array<{path: string; options?: JiraRequestOptions}> = [];
  response: unknown = {};

  async request<T>(path: string, options?: JiraRequestOptions): Promise<T> {
    this.calls.push({path, options});
    return this.response as T;
  }
}

void test('converts plain text to ADF without empty spacer paragraphs', () => {
  const adf = textToAdf('First line\nsecond line\n\n\nNew paragraph');
  assert.equal(adf.type, 'doc');
  assert.equal(adf.version, 1);
  assert.deepEqual(
    adf.content?.map(node => node.type),
    ['paragraph', 'paragraph'],
  );
  assert.equal(
    adfToText(adf).trimEnd(),
    'First line\nsecond line\n\nNew paragraph',
  );
});

void test('converts structured Markdown to native Jira ADF nodes', () => {
  const adf = textToAdf(
    [
      '## Network investigation',
      '',
      '> [!INFO] **Finding:** No broad regression in the `network path`.',
      '',
      '### Request path',
      '',
      '```text',
      'Browser → CloudFront → Envoy → Gunicorn',
      '```',
      '',
      '- First route',
      '- [Second route](https://example.com/route)',
      '',
      '| Measurement | Before | After |',
      '| --- | --- | --- |',
      '| p95 TTFB | 3.25s | 3.22s |',
      '',
      '1. Capture a HAR',
      '2. Correlate the request',
    ].join('\n'),
  );

  assert.deepEqual(
    adf.content?.map(node => node.type),
    [
      'heading',
      'panel',
      'heading',
      'codeBlock',
      'bulletList',
      'table',
      'orderedList',
    ],
  );
  assert.deepEqual(adf.content?.[0].attrs, {level: 2});
  assert.deepEqual(adf.content?.[1].attrs, {panelType: 'info'});
  assert.deepEqual(adf.content?.[3].attrs, {language: 'text'});
  assert.equal(adf.content?.[4].content?.length, 2);
  assert.equal(adf.content?.[5].content?.length, 2);
  assert.equal(adf.content?.[6].content?.length, 2);

  const panelText = adf.content?.[1].content?.[0].content ?? [];
  assert.deepEqual(panelText[0].marks, [{type: 'strong'}]);
  assert.deepEqual(panelText[2].marks, [{type: 'code'}]);

  const link = adf.content?.[4].content?.[1].content?.[0].content?.[0];
  assert.deepEqual(link?.marks, [
    {type: 'link', attrs: {href: 'https://example.com/route'}},
  ]);
});

void test('upgrades legacy uppercase sections and bullet characters', () => {
  const adf = textToAdf(`NETWORK-PATH INVESTIGATION — 2026-08-19

REQUEST PATH

Routing populations:
• /agent/policies/ko_policy_list uses Kubernetes.
• SPA content uses S3.`);

  assert.deepEqual(
    adf.content?.map(node => node.type),
    ['heading', 'heading', 'paragraph', 'bulletList'],
  );
  assert.deepEqual(adf.content?.[0].attrs, {level: 2});
  assert.deepEqual(adf.content?.[1].attrs, {level: 3});
  assert.match(adfToText(adf), /ko_policy_list/);
});

void test('search uses enhanced JQL endpoint with bounded request shape', async () => {
  const client = new RecordingClient();
  await searchIssues(client, {
    jql: 'project = BC',
    fields: ['summary', 'status'],
    maxResults: 25,
  });
  assert.deepEqual(client.calls[0], {
    path: '/rest/api/3/search/jql',
    options: {
      method: 'POST',
      body: {
        jql: 'project = BC',
        fields: ['summary', 'status'],
        maxResults: 25,
      },
      signal: undefined,
    },
  });
});

void test('issue creation sends fields payload', async () => {
  const client = new RecordingClient();
  client.response = {key: 'BC-123'};
  const response = await createIssue(client, {
    project: {key: 'BC'},
    issuetype: {name: 'Task'},
    summary: 'Example',
  });
  assert.equal(response.key, 'BC-123');
  assert.deepEqual(client.calls[0].options?.body, {
    fields: {
      project: {key: 'BC'},
      issuetype: {name: 'Task'},
      summary: 'Example',
    },
  });
});

void test('transitions and comment edits use purpose-built endpoints', async () => {
  const client = new RecordingClient();
  await transitionIssue(client, 'BC-123', '31');
  await editComment(client, 'BC-123', '10001', textToAdf('Updated'));
  assert.equal(client.calls[0].path, '/rest/api/3/issue/BC-123/transitions');
  assert.deepEqual(client.calls[0].options?.body, {transition: {id: '31'}});
  assert.equal(client.calls[1].path, '/rest/api/3/issue/BC-123/comment/10001');
  assert.equal(client.calls[1].options?.method, 'PUT');
});

void test('JiraClient sends basic authentication without exposing token', async () => {
  const originalFetch = globalThis.fetch;
  let authorization = '';
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({accountId: 'a1'}), {status: 200});
  };
  try {
    const client = new JiraClient({
      baseUrl: 'https://example.atlassian.net',
      username: 'user@example.com',
      apiToken: 'secret',
    });
    await client.request('/rest/api/3/myself');
    assert.equal(
      authorization,
      `Basic ${Buffer.from('user@example.com:secret').toString('base64')}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
