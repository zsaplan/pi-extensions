# @zsaplan/pi-jira

Pi extension for reading Jira Cloud and writing issues and comments through purpose-built tools. It intentionally provides no delete operations.

## Configuration

```bash
export JIRA_BASE_URL=https://britecore.atlassian.net
export JIRA_USERNAME=you@example.com
export JIRA_API_TOKEN=...
export JIRA_ACCOUNT_ID=... # optional, used for configuration status
```

The extension uses Jira Cloud basic authentication with `JIRA_USERNAME:JIRA_API_TOKEN`. Start Pi after setting the variables.

## Tools

Read tools:

- `jira_auth_test`
- `jira_search_issues`
- `jira_get_issue`
- `jira_list_projects`
- `jira_get_create_metadata`
- `jira_get_transitions`
- `jira_list_comments`

Write tools:

- `jira_create_issue`
- `jira_edit_issue`
- `jira_transition_issue`
- `jira_add_comment`
- `jira_edit_comment`

Descriptions and comments accept Jira-flavored Markdown and are converted to native Atlassian Document Format nodes. Supported formatting includes:

- Headings (`## Heading`)
- Bulleted and numbered lists
- Tables
- Fenced code blocks
- GitHub-style callouts such as `> [!INFO] Finding`
- Bold, emphasis, inline code, and links

Legacy all-uppercase section labels and `•` bullets are also upgraded automatically. Blank input lines separate blocks without creating empty spacer paragraphs.

Read results retain raw ADF and add extracted plain-text fields. Status is returned by normal issue reads/searches and changed only through workflow transitions.

Writes do not display an approval dialog. Tool guidance requires an explicit user request before mutation.

## Command

```text
/jira
/jira test
```

## Local development

From the repository root:

```bash
npm run verify --workspace jira
```
