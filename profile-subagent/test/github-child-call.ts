import type {ToolCall} from '@earendil-works/pi-ai';

// Independent expected model-facing contract for source, bundled and packed E2E hosts.
export const childNames: Record<string, string> = {
  repositories: 'github_repositories',
  resolve: 'github_resolve',
  list: 'github_list_directory',
  search: 'github_search_directory',
  file: 'github_file',
  history: 'github_history',
  discussion: 'github_discussion',
};
export function childCall(action: ToolCall['arguments']) {
  const {operation, ...args} = action;
  const name = childNames[String(operation)] ?? 'github_research_read';
  if ((operation === 'list' || operation === 'search') && 'path' in args) {
    args.directory = args.path;
    delete args.path;
  }
  return {name, arguments: args};
}
