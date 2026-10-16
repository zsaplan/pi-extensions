# Jira Extension Design

## Mission

Give Pi bounded Jira Cloud access through explicit read tools and issue/comment write tools, without exposing a generic API request primitive.

## Boundaries

- Authentication comes only from `JIRA_BASE_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN`; `JIRA_ACCOUNT_ID` is optional metadata.
- Writes are limited to creating/editing/transitioning issues and adding/editing comments.
- Delete operations are intentionally absent.
- Status is read from issue fields and changed through Jira workflow transitions.
- Jira-flavored Markdown is converted directly to native Atlassian Document Format nodes for descriptions and comments; plain text remains valid input.
- There is no write confirmation dialog; system-prompt guidance limits writes to explicit user requests.
- API output is truncated to Pi's standard line/byte limits.

## Structure

- `src/config.ts` validates environment configuration.
- `src/jira.ts` owns Jira HTTP transport, endpoint wrappers, errors, and the dependency-free Markdown-to-ADF conversion.
- `src/index.ts` defines Pi commands, tools, schemas, formatting, and tool guidance.
