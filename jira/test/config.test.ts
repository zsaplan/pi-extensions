import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {readJiraConfig} from '../src/config.ts';

void test('reads and normalizes Jira configuration', () => {
  const status = readJiraConfig({
    JIRA_BASE_URL: 'https://example.atlassian.net/',
    JIRA_USERNAME: 'user@example.com',
    JIRA_API_TOKEN: 'secret',
    JIRA_ACCOUNT_ID: 'account-1',
  });
  assert.deepEqual(status.settings, {
    baseUrl: 'https://example.atlassian.net',
    username: 'user@example.com',
    apiToken: 'secret',
    accountId: 'account-1',
  });
});

void test('reports missing required configuration', () => {
  const status = readJiraConfig({});
  assert.match(status.problem ?? '', /JIRA_BASE_URL/);
  assert.match(status.problem ?? '', /JIRA_USERNAME/);
  assert.match(status.problem ?? '', /JIRA_API_TOKEN/);
});

void test('rejects non-HTTPS base URL', () => {
  const status = readJiraConfig({
    JIRA_BASE_URL: 'http://example.test',
    JIRA_USERNAME: 'user@example.com',
    JIRA_API_TOKEN: 'secret',
  });
  assert.match(status.problem ?? '', /HTTPS/);
});
