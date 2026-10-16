import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {Type, type Static} from 'typebox';
import {getJiraConfigStatusMessage, readJiraConfig} from './config.ts';
import {
  JiraClient,
  addComment,
  adfToText,
  createIssue,
  editComment,
  editIssue,
  getCreateMetadata,
  getIssue,
  getMyself,
  getTransitions,
  listComments,
  listProjects,
  searchIssues,
  textToAdf,
  transitionIssue,
  type JiraApiCaller,
  type JiraComment,
  type JiraIssue,
} from './jira.ts';

const ISSUE_KEY = Type.String({
  description: 'Jira issue key, for example BC-123.',
});
const LIMIT = Type.Optional(Type.Integer({minimum: 1, maximum: 100}));
const START_AT = Type.Optional(Type.Integer({minimum: 0}));
const FIELDS = Type.Optional(
  Type.Array(Type.String(), {
    maxItems: 100,
    description: 'Jira fields to return.',
  }),
);
const EXTRA_FIELDS = Type.Optional(
  Type.Record(Type.String(), Type.Unknown(), {
    description:
      'Additional Jira field IDs and values, including custom fields.',
  }),
);
const AUTH_SCHEMA = Type.Object({});
const SEARCH_SCHEMA = Type.Object({
  jql: Type.String({description: 'Jira Query Language expression.'}),
  fields: FIELDS,
  maxResults: LIMIT,
  nextPageToken: Type.Optional(Type.String()),
});
const GET_ISSUE_SCHEMA = Type.Object({issueKey: ISSUE_KEY, fields: FIELDS});
const LIST_PROJECTS_SCHEMA = Type.Object({
  query: Type.Optional(
    Type.String({description: 'Optional project name/key filter.'}),
  ),
  startAt: START_AT,
  maxResults: Type.Optional(Type.Integer({minimum: 1, maximum: 50})),
});
const CREATE_METADATA_SCHEMA = Type.Object({
  projectIdOrKey: Type.String(),
  issueTypeId: Type.Optional(
    Type.String({
      description: 'When supplied, return fields for this issue type.',
    }),
  ),
});
const TRANSITIONS_SCHEMA = Type.Object({issueKey: ISSUE_KEY});
const CREATE_ISSUE_SCHEMA = Type.Object({
  projectKey: Type.String(),
  issueType: Type.String({
    description: 'Jira issue type name, for example Task or Bug.',
  }),
  summary: Type.String(),
  description: Type.Optional(
    Type.String({description: 'Jira-flavored Markdown converted to Jira ADF.'}),
  ),
  fields: EXTRA_FIELDS,
});
const EDIT_ISSUE_SCHEMA = Type.Object({
  issueKey: ISSUE_KEY,
  summary: Type.Optional(Type.String()),
  description: Type.Optional(
    Type.String({description: 'Jira-flavored Markdown converted to Jira ADF.'}),
  ),
  fields: EXTRA_FIELDS,
});
const TRANSITION_ISSUE_SCHEMA = Type.Object({
  issueKey: ISSUE_KEY,
  transitionId: Type.String({
    description: 'Transition ID returned by jira_get_transitions.',
  }),
});
const LIST_COMMENTS_SCHEMA = Type.Object({
  issueKey: ISSUE_KEY,
  startAt: START_AT,
  maxResults: LIMIT,
});
const RICH_TEXT_DESCRIPTION =
  'Jira-flavored Markdown converted to native Jira formatting. Supports headings, bullets, numbered lists, tables, fenced code blocks, GitHub-style callouts, bold, emphasis, inline code, and links.';
const ADD_COMMENT_SCHEMA = Type.Object({
  issueKey: ISSUE_KEY,
  body: Type.String({description: RICH_TEXT_DESCRIPTION}),
});
const EDIT_COMMENT_SCHEMA = Type.Object({
  issueKey: ISSUE_KEY,
  commentId: Type.String(),
  body: Type.String({description: `Replacement ${RICH_TEXT_DESCRIPTION}`}),
});

type SearchParams = Static<typeof SEARCH_SCHEMA>;
type GetIssueParams = Static<typeof GET_ISSUE_SCHEMA>;
type ListProjectsParams = Static<typeof LIST_PROJECTS_SCHEMA>;
type CreateMetadataParams = Static<typeof CREATE_METADATA_SCHEMA>;
type CreateIssueParams = Static<typeof CREATE_ISSUE_SCHEMA>;
type EditIssueParams = Static<typeof EDIT_ISSUE_SCHEMA>;
type TransitionParams = Static<typeof TRANSITION_ISSUE_SCHEMA>;
type ListCommentsParams = Static<typeof LIST_COMMENTS_SCHEMA>;
type AddCommentParams = Static<typeof ADD_COMMENT_SCHEMA>;
type EditCommentParams = Static<typeof EDIT_COMMENT_SCHEMA>;

function requireClient(): JiraApiCaller {
  const status = readJiraConfig();
  if (!status.settings)
    throw new Error(status.problem ?? 'Jira is not configured.');
  return new JiraClient(status.settings);
}

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Math.max(1, Math.min(maximum, Math.floor(value ?? fallback)));
}

function withStatusField(fields: string[] | undefined): string[] | undefined {
  if (!fields) return undefined;
  return [...new Set([...fields, 'status'])];
}

function rejectStatusField(fields: Record<string, unknown> | undefined): void {
  if (fields && Object.hasOwn(fields, 'status')) {
    throw new Error(
      'Jira status cannot be edited as a field. Use jira_get_transitions and jira_transition_issue.',
    );
  }
}

function result(value: unknown, details: Record<string, unknown> = {}) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const suffix = truncated.truncated
    ? `\n\n[Jira output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Rerun with narrower fields or limits.]`
    : '';
  return {
    content: [{type: 'text' as const, text: `${truncated.content}${suffix}`}],
    details: {
      ...details,
      ...(truncated.truncated ? {truncated: true} : {}),
    },
  };
}

function enrichIssue(issue: JiraIssue): Record<string, unknown> {
  const description = issue.fields?.description;
  return {
    ...issue,
    fields: {
      ...issue.fields,
      ...(description
        ? {descriptionText: adfToText(description).trimEnd()}
        : {}),
    },
  };
}

function enrichComment(comment: JiraComment): Record<string, unknown> {
  return {...comment, bodyText: adfToText(comment.body).trimEnd()};
}

async function jiraCommand(args: string, ctx: ExtensionCommandContext) {
  const status = readJiraConfig();
  if (!args.trim()) {
    if (ctx.hasUI)
      ctx.ui.notify(
        getJiraConfigStatusMessage(status),
        status.settings ? 'info' : 'warning',
      );
    return;
  }
  if (args.trim().toLowerCase() !== 'test') {
    if (ctx.hasUI) ctx.ui.notify('Usage: /jira [test]', 'warning');
    return;
  }
  if (!status.settings) throw new Error(status.problem);
  const user = await getMyself(new JiraClient(status.settings));
  if (ctx.hasUI)
    ctx.ui.notify(
      `Jira auth OK: ${user.displayName ?? user.accountId ?? 'unknown user'}`,
      'info',
    );
}

export default function jiraExtension(pi: ExtensionAPI) {
  pi.registerCommand('jira', {
    description: 'Show Jira configuration status or test Jira authentication.',
    handler: jiraCommand,
  });

  pi.registerTool({
    name: 'jira_auth_test',
    label: 'Jira Auth Test',
    description:
      'Validate Jira Cloud credentials and return sanitized account identity.',
    promptSnippet: 'Validate configured Jira Cloud credentials.',
    promptGuidelines: [
      'Use jira_auth_test when Jira tools fail due to authentication or when the user asks which Jira identity is configured.',
    ],
    parameters: AUTH_SCHEMA,
    async execute(_id, _params, signal) {
      const user = await getMyself(requireClient(), signal);
      return result({
        accountId: user.accountId,
        active: user.active,
        displayName: user.displayName,
        emailAddress: user.emailAddress,
      });
    },
  });

  pi.registerTool({
    name: 'jira_search_issues',
    label: 'Jira Search Issues',
    description:
      'Search Jira issues with JQL. Results default to key, summary, status, assignee, priority, and updated.',
    promptSnippet: 'Search Jira issues with JQL.',
    promptGuidelines: [
      'Use jira_search_issues for issue discovery and filtered issue lists; keep maxResults and returned fields narrow.',
    ],
    parameters: SEARCH_SCHEMA,
    async execute(_id, params: SearchParams, signal) {
      const fields = withStatusField(params.fields) ?? [
        'summary',
        'status',
        'assignee',
        'priority',
        'updated',
      ];
      const response = await searchIssues(
        requireClient(),
        {
          jql: params.jql,
          fields,
          maxResults: bounded(params.maxResults, 25, 100),
          nextPageToken: params.nextPageToken,
        },
        signal,
      );
      return result(
        {...response, issues: (response.issues ?? []).map(enrichIssue)},
        {count: response.issues?.length ?? 0},
      );
    },
  });

  pi.registerTool({
    name: 'jira_get_issue',
    label: 'Jira Get Issue',
    description:
      'Get a Jira issue, including its current status. Description ADF is accompanied by extracted plain text.',
    promptSnippet: 'Read a Jira issue and its current status.',
    promptGuidelines: [
      'Use jira_get_issue when an issue key is known and current fields or status are needed.',
    ],
    parameters: GET_ISSUE_SCHEMA,
    async execute(_id, params: GetIssueParams, signal) {
      return result(
        enrichIssue(
          await getIssue(
            requireClient(),
            params.issueKey,
            withStatusField(params.fields),
            signal,
          ),
        ),
        {issueKey: params.issueKey},
      );
    },
  });

  pi.registerTool({
    name: 'jira_list_projects',
    label: 'Jira List Projects',
    description: 'List Jira projects visible to the configured account.',
    promptSnippet: 'List visible Jira projects.',
    promptGuidelines: [
      'Use jira_list_projects to resolve a Jira project key before creating an issue.',
    ],
    parameters: LIST_PROJECTS_SCHEMA,
    async execute(_id, params: ListProjectsParams, signal) {
      return result(
        await listProjects(
          requireClient(),
          {
            query: params.query,
            startAt: params.startAt ?? 0,
            maxResults: bounded(params.maxResults, 25, 50),
          },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: 'jira_get_create_metadata',
    label: 'Jira Get Create Metadata',
    description:
      'List issue types for a Jira project, or fields allowed when creating one issue type.',
    promptSnippet: 'Inspect Jira issue types and create fields.',
    promptGuidelines: [
      'Use jira_get_create_metadata before jira_create_issue when the project issue type or required/custom fields are uncertain.',
    ],
    parameters: CREATE_METADATA_SCHEMA,
    async execute(_id, params: CreateMetadataParams, signal) {
      return result(
        await getCreateMetadata(
          requireClient(),
          params.projectIdOrKey,
          params.issueTypeId,
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: 'jira_get_transitions',
    label: 'Jira Get Transitions',
    description:
      'List currently available workflow transitions for a Jira issue.',
    promptSnippet: 'List available Jira issue status transitions.',
    promptGuidelines: [
      'Always use jira_get_transitions before jira_transition_issue to select a currently valid transition ID.',
    ],
    parameters: TRANSITIONS_SCHEMA,
    async execute(_id, params: Static<typeof TRANSITIONS_SCHEMA>, signal) {
      return result(
        await getTransitions(requireClient(), params.issueKey, signal),
        {issueKey: params.issueKey},
      );
    },
  });

  pi.registerTool({
    name: 'jira_create_issue',
    label: 'Jira Create Issue',
    description:
      'Create a Jira issue. Jira-flavored Markdown descriptions are converted to native Jira formatting.',
    promptSnippet: 'Create a Jira issue.',
    promptGuidelines: [
      'Use jira_create_issue only when the user explicitly asks to create an issue; use jira_get_create_metadata first if required fields are uncertain.',
    ],
    parameters: CREATE_ISSUE_SCHEMA,
    async execute(_id, params: CreateIssueParams, signal) {
      rejectStatusField(params.fields);
      const fields = {
        ...(params.fields ?? {}),
        project: {key: params.projectKey},
        issuetype: {name: params.issueType},
        summary: params.summary,
        ...(params.description === undefined
          ? {}
          : {description: textToAdf(params.description)}),
      };
      const created = await createIssue(requireClient(), fields, signal);
      return result(created, {issueKey: created.key});
    },
  });

  pi.registerTool({
    name: 'jira_edit_issue',
    label: 'Jira Edit Issue',
    description:
      'Edit Jira issue fields. Status changes must use jira_transition_issue.',
    promptSnippet: 'Edit fields on an existing Jira issue.',
    promptGuidelines: [
      'Use jira_edit_issue only when the user explicitly asks to modify an issue. Use jira_transition_issue, not jira_edit_issue, for status changes.',
    ],
    parameters: EDIT_ISSUE_SCHEMA,
    async execute(_id, params: EditIssueParams, signal) {
      rejectStatusField(params.fields);
      const fields = {
        ...(params.fields ?? {}),
        ...(params.summary === undefined ? {} : {summary: params.summary}),
        ...(params.description === undefined
          ? {}
          : {description: textToAdf(params.description)}),
      };
      if (!Object.keys(fields).length)
        throw new Error('At least one issue field must be supplied.');
      await editIssue(requireClient(), params.issueKey, fields, signal);
      return result(`Updated Jira issue ${params.issueKey}.`, {
        issueKey: params.issueKey,
      });
    },
  });

  pi.registerTool({
    name: 'jira_transition_issue',
    label: 'Jira Transition Issue',
    description:
      'Transition a Jira issue using a currently available workflow transition ID.',
    promptSnippet: 'Transition a Jira issue to another status.',
    promptGuidelines: [
      'Use jira_transition_issue only when the user explicitly asks for a status change, and call jira_get_transitions first to obtain the valid transition ID.',
    ],
    parameters: TRANSITION_ISSUE_SCHEMA,
    async execute(_id, params: TransitionParams, signal) {
      await transitionIssue(
        requireClient(),
        params.issueKey,
        params.transitionId,
        signal,
      );
      return result(`Transitioned Jira issue ${params.issueKey}.`, {
        issueKey: params.issueKey,
        transitionId: params.transitionId,
      });
    },
  });

  pi.registerTool({
    name: 'jira_list_comments',
    label: 'Jira List Comments',
    description:
      'List comments on a Jira issue. Each ADF body includes extracted plain text.',
    promptSnippet: 'Read comments on a Jira issue.',
    promptGuidelines: [
      'Use jira_list_comments to read issue discussion; keep maxResults narrow.',
    ],
    parameters: LIST_COMMENTS_SCHEMA,
    async execute(_id, params: ListCommentsParams, signal) {
      const response = await listComments(
        requireClient(),
        params.issueKey,
        {
          startAt: params.startAt ?? 0,
          maxResults: bounded(params.maxResults, 25, 100),
        },
        signal,
      );
      return result(
        {...response, comments: (response.comments ?? []).map(enrichComment)},
        {issueKey: params.issueKey},
      );
    },
  });

  pi.registerTool({
    name: 'jira_add_comment',
    label: 'Jira Add Comment',
    description:
      'Add a Jira-flavored Markdown comment with native Jira rich formatting.',
    promptSnippet: 'Add a richly formatted comment to a Jira issue.',
    promptGuidelines: [
      'Use jira_add_comment only when the user explicitly asks to post a Jira comment; do not post drafts.',
      'For substantial jira_add_comment posts, structure the body with Markdown headings, real lists, tables for comparisons, fenced code blocks for paths or code, and > [!INFO] callouts for key findings instead of simulating formatting with capitalization or bullet characters.',
    ],
    parameters: ADD_COMMENT_SCHEMA,
    async execute(_id, params: AddCommentParams, signal) {
      const comment = await addComment(
        requireClient(),
        params.issueKey,
        textToAdf(params.body),
        signal,
      );
      return result(enrichComment(comment), {
        commentId: comment.id,
        issueKey: params.issueKey,
      });
    },
  });

  pi.registerTool({
    name: 'jira_edit_comment',
    label: 'Jira Edit Comment',
    description:
      'Replace a Jira comment using Jira-flavored Markdown and native Jira rich formatting.',
    promptSnippet: 'Edit an existing Jira comment with rich formatting.',
    promptGuidelines: [
      'Use jira_edit_comment only when the user explicitly asks to replace an existing Jira comment.',
      'For substantial jira_edit_comment posts, structure the body with Markdown headings, real lists, tables for comparisons, fenced code blocks for paths or code, and > [!INFO] callouts for key findings instead of simulating formatting with capitalization or bullet characters.',
    ],
    parameters: EDIT_COMMENT_SCHEMA,
    async execute(_id, params: EditCommentParams, signal) {
      const comment = await editComment(
        requireClient(),
        params.issueKey,
        params.commentId,
        textToAdf(params.body),
        signal,
      );
      return result(enrichComment(comment), {
        commentId: params.commentId,
        issueKey: params.issueKey,
      });
    },
  });
}
