import {githubChildToolNames} from './github-tools.ts';

type Observation = {integrity: string; isError: boolean; content: unknown};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function hasClipping(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (/truncated$|^hasNext$|^collectionLimited$|^incompleteResults$/i.test(
        key,
      ) &&
        item === true) ||
      (/^omitted/.test(key) && typeof item === 'number' && item > 0) ||
      hasClipping(item),
  );
}

// Counts only: no raw arguments, error text, withheld content or receipt recovery.
export function createGithubActivity() {
  const byTool = new Map<string, {returned: number; failed: number}>();
  return {
    observe(message: {toolName: string; isError: boolean}) {
      const name = githubChildToolNames.some(name => name === message.toolName)
        ? message.toolName
        : 'other';
      const counts = byTool.get(name) ?? {returned: 0, failed: 0};
      counts.returned++;
      if (message.isError) counts.failed++;
      byTool.set(name, counts);
    },
    snapshot(
      observations: Observation[],
      omitted: number,
      unreturned: number,
      omittedFailureDetails: number,
    ) {
      const outcomes = {
        ok: 0,
        refused: 0,
        unavailable: 0,
        unknownOrModified: 0,
      };
      const successfulOperations = {
        repositories: 0,
        resolve: 0,
        list: 0,
        search: 0,
        file: 0,
        history: 0,
        discussion: 0,
      };
      let clippedOrPaginated = 0,
        partialFileWindows = 0,
        unavailableSearchFiles = 0,
        pagesWithEarlierPagesOutsideResponse = 0,
        responsesWithoutAttachmentInspection = 0;
      for (const observation of observations) {
        let value: unknown;
        if (observation.integrity === 'intact-adapter-observation') {
          try {
            const content = observation.content as {
              type: string;
              text: string;
            }[];
            if (content.length === 1 && content[0].type === 'text')
              value = JSON.parse(content[0].text);
          } catch {
            /* Modified/unparseable data is unknown, never reconstructed. */
          }
        }
        if (
          !isObject(value) ||
          !['ok', 'refused', 'unavailable'].includes(String(value.status))
        ) {
          outcomes.unknownOrModified++;
          continue;
        }
        const status = value.status as 'ok' | 'refused' | 'unavailable';
        outcomes[status]++;
        if (status !== 'ok' || observation.isError) continue;
        if (
          typeof value.operation === 'string' &&
          Object.hasOwn(successfulOperations, value.operation)
        )
          successfulOperations[
            value.operation as keyof typeof successfulOperations
          ]++;
        if (hasClipping(value)) clippedOrPaginated++;
        const coverage = isObject(value.coverage) ? value.coverage : {};
        if (
          value.operation === 'file' &&
          typeof coverage.omittedLines === 'number' &&
          coverage.omittedLines > 0
        )
          partialFileWindows++;
        if (value.operation === 'search' && Array.isArray(coverage.unavailable))
          unavailableSearchFiles += coverage.unavailable.length;
        if (
          coverage.earlierPagesNotObserved === true ||
          value.earlierPagesNotObserved === true
        )
          pagesWithEarlierPagesOutsideResponse++;
        if (coverage.attachments === 'not read')
          responsesWithoutAttachmentInspection++;
      }
      const tools = [...byTool].map(([tool, counts]) => ({tool, ...counts}));
      const returned = tools.reduce((n, t) => n + t.returned, 0);
      const failed = tools.reduce((n, t) => n + t.failed, 0);
      return {
        authority:
          'Host-recorded child tool results and retained intact post-parent-hook observations; not model-reported counts.',
        headline: `${failed} failed child tool results out of ${returned} returned; ${omitted} source observations omitted from the packet.`,
        childToolResults: {
          returned,
          succeeded: returned - failed,
          failed,
          byTool: tools,
          omittedFailureDetails,
        },
        sourceObservations: {
          retained: observations.length,
          omitted,
          unreturnedParentCalls: unreturned,
          outcomes,
        },
        observedCoverage: {
          successfulOperations,
          clippedOrPaginated,
          partialFileWindows,
          unavailableSearchFiles,
          pagesWithEarlierPagesOutsideResponse,
          responsesWithoutAttachmentInspection,
        },
        limits:
          'Outcome counts overlap with child tool failures; do not add them. Coverage counts exclude omitted, modified and unreturned observations. Counts are per observation, not unique files or merged coverage. They do not establish complete repository coverage, claim support or question completion. See sourceEvidence for individual records and gaps.',
      };
    },
  };
}
