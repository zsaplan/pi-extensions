import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from '@mariozechner/pi-coding-agent';
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@mariozechner/pi-tui';

const MIN_COLUMN_GAP = 2;
const RESERVED_LEFT_RATIO = 0.4;
const MAX_RESERVED_LEFT_WIDTH = 30;
const FOOTER_KEY = 'session-file-footer';

export function sanitizeFooterText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function abbreviateHome(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return filePath;

  const normalizedHome = path.normalize(home);
  const normalizedPath = path.normalize(filePath);
  if (normalizedPath === normalizedHome) return '~';

  const homeWithSeparator = normalizedHome.endsWith(path.sep)
    ? normalizedHome
    : `${normalizedHome}${path.sep}`;
  if (!normalizedPath.startsWith(homeWithSeparator)) return filePath;

  return `~${normalizedPath.slice(normalizedHome.length)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function truncateStartToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return truncateToWidth('…', width, '');

  const ellipsis = '…';
  const suffixTargetWidth = width - visibleWidth(ellipsis);
  const characters = Array.from(text);
  let suffix = '';

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const next = `${characters[index]}${suffix}`;
    if (visibleWidth(next) > suffixTargetWidth) break;
    suffix = next;
  }

  return `${ellipsis}${suffix}`;
}

export function padEndToWidth(text: string, width: number): string {
  if (width <= 0) return '';

  const textWidth = visibleWidth(text);
  if (textWidth > width) return truncateToWidth(text, width, '');
  return `${text}${' '.repeat(width - textWidth)}`;
}

export function buildSplitLine(
  left: string,
  right: string | undefined,
  width: number,
): string {
  if (width <= 0) return '';

  const cleanLeft = sanitizeFooterText(left);
  const cleanRight = right ? sanitizeFooterText(right) : undefined;
  if (!cleanRight)
    return padEndToWidth(truncateToWidth(cleanLeft, width, '...'), width);

  const leftWidth = visibleWidth(cleanLeft);
  const rightWidth = visibleWidth(cleanRight);
  if (leftWidth + MIN_COLUMN_GAP + rightWidth <= width) {
    return `${cleanLeft}${' '.repeat(width - leftWidth - rightWidth)}${cleanRight}`;
  }

  const reservedLeftWidth = Math.min(
    leftWidth,
    MAX_RESERVED_LEFT_WIDTH,
    Math.max(0, Math.floor(width * RESERVED_LEFT_RATIO)),
  );
  const rightBudget = Math.max(0, width - MIN_COLUMN_GAP - reservedLeftWidth);
  const truncatedRight = truncateStartToWidth(cleanRight, rightBudget);
  const leftBudget = Math.max(
    0,
    width - MIN_COLUMN_GAP - visibleWidth(truncatedRight),
  );
  const truncatedLeft = truncateToWidth(cleanLeft, leftBudget, '...');
  const gapWidth = Math.max(
    0,
    width - visibleWidth(truncatedLeft) - visibleWidth(truncatedRight),
  );

  return padEndToWidth(
    `${truncatedLeft}${' '.repeat(gapWidth)}${truncatedRight}`,
    width,
  );
}

export function buildLocationLabel(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  footerData: Pick<ReadonlyFooterDataProvider, 'getGitBranch'>,
): string {
  let label = abbreviateHome(ctx.sessionManager.getCwd());

  const branch = footerData.getGitBranch();
  if (branch) label = `${label} (${branch})`;

  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) label = `${label} • ${sessionName}`;

  return label;
}

export function buildSessionFileLabel(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return `jsonl: ${sessionFile ? abbreviateHome(sessionFile) : 'ephemeral'}`;
}

function buildContextPercentDisplay(ctx: ExtensionContext): {
  display: string;
  value: number | null;
} {
  const contextUsage = ctx.getContextUsage();
  const contextWindow =
    contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (contextUsage?.percent === null || contextUsage?.percent === undefined) {
    return {
      display: `?/${formatTokens(contextWindow)}`,
      value: null,
    };
  }

  return {
    display: `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)}`,
    value: contextUsage.percent,
  };
}

function buildStatsLeft(ctx: ExtensionContext, theme: Theme): string {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      totalInput += entry.message.usage.input;
      totalOutput += entry.message.usage.output;
      totalCacheRead += entry.message.usage.cacheRead;
      totalCacheWrite += entry.message.usage.cacheWrite;
      totalCost += entry.message.usage.cost.total;
    }
  }

  const statsParts: string[] = [];
  if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

  const usingSubscription = ctx.model
    ? ctx.modelRegistry.isUsingOAuth(ctx.model)
    : false;
  if (totalCost || usingSubscription) {
    statsParts.push(
      `$${totalCost.toFixed(3)}${usingSubscription ? ' (sub)' : ''}`,
    );
  }

  const contextPercent = buildContextPercentDisplay(ctx);
  if (contextPercent.value !== null && contextPercent.value > 90) {
    statsParts.push(theme.fg('error', contextPercent.display));
  } else if (contextPercent.value !== null && contextPercent.value > 70) {
    statsParts.push(theme.fg('warning', contextPercent.display));
  } else {
    statsParts.push(contextPercent.display);
  }

  return statsParts.join(' ');
}

function buildModelLabel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  footerData: Pick<ReadonlyFooterDataProvider, 'getAvailableProviderCount'>,
  statsLeftWidth: number,
  width: number,
): string {
  const modelName = ctx.model?.id || 'no-model';
  let labelWithoutProvider = modelName;

  if (ctx.model?.reasoning) {
    const thinkingLevel = pi.getThinkingLevel();
    labelWithoutProvider =
      thinkingLevel === 'off'
        ? `${modelName} • thinking off`
        : `${modelName} • ${thinkingLevel}`;
  }

  if (footerData.getAvailableProviderCount() <= 1 || !ctx.model) {
    return labelWithoutProvider;
  }

  const labelWithProvider = `(${ctx.model.provider}) ${labelWithoutProvider}`;
  if (
    statsLeftWidth + MIN_COLUMN_GAP + visibleWidth(labelWithProvider) >
    width
  ) {
    return labelWithoutProvider;
  }

  return labelWithProvider;
}

function renderStatsLine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  footerData: Pick<ReadonlyFooterDataProvider, 'getAvailableProviderCount'>,
  theme: Theme,
  width: number,
): string {
  let statsLeft = buildStatsLeft(ctx, theme);
  let statsLeftWidth = visibleWidth(statsLeft);

  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, '...');
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const rightSide = buildModelLabel(pi, ctx, footerData, statsLeftWidth, width);
  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + MIN_COLUMN_GAP + rightSideWidth;

  let statsLine: string;
  if (totalNeeded <= width) {
    statsLine = `${statsLeft}${' '.repeat(width - statsLeftWidth - rightSideWidth)}${rightSide}`;
  } else {
    const availableForRight = width - statsLeftWidth - MIN_COLUMN_GAP;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, '');
      const padding = ' '.repeat(
        Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
      );
      statsLine = `${statsLeft}${padding}${truncatedRight}`;
    } else {
      statsLine = statsLeft;
    }
  }

  const remainder = statsLine.slice(statsLeft.length);
  return padEndToWidth(
    theme.fg('dim', statsLeft) + theme.fg('dim', remainder),
    width,
  );
}

function renderStatusLine(
  footerData: Pick<ReadonlyFooterDataProvider, 'getExtensionStatuses'>,
  theme: Theme,
  width: number,
): string | undefined {
  const extensionStatuses = footerData.getExtensionStatuses();
  if (extensionStatuses.size === 0) return undefined;

  const statusLine = Array.from(extensionStatuses.entries())
    .filter(([key]) => key !== FOOTER_KEY)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeFooterText(text))
    .join(' ');

  if (!statusLine) return undefined;
  return padEndToWidth(
    truncateToWidth(statusLine, width, theme.fg('dim', '...')),
    width,
  );
}

function createFooterComponent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  requestRender: () => void,
): Component & {dispose(): void} {
  const unsubscribe = footerData.onBranchChange(requestRender);

  return {
    dispose: unsubscribe,
    invalidate() {},
    render(width: number): string[] {
      const locationLine = buildSplitLine(
        buildLocationLabel(ctx, footerData),
        buildSessionFileLabel(ctx),
        width,
      );
      const lines = [
        theme.fg('dim', locationLine),
        renderStatsLine(pi, ctx, footerData, theme, width),
      ];

      const statusLine = renderStatusLine(footerData, theme, width);
      if (statusLine) lines.push(statusLine);

      return lines;
    },
  };
}

export default function sessionFileFooter(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) =>
      createFooterComponent(pi, ctx, theme, footerData, () =>
        tui.requestRender(),
      ),
    );
  });
}
