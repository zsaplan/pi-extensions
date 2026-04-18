const reviewData = JSON.parse(
  document.getElementById('response-review-data').textContent || '{}',
);

const allResponses = [...(reviewData.responses || [])].sort(
  (a, b) => b.index - a.index,
);
const responseById = new Map(
  allResponses.map(response => [response.id, response]),
);

const state = {
  activeResponseId: allResponses[0]?.id ?? null,
  wrapLines: true,
  sidebarCollapsed: false,
  search: '',
  drafts: {},
  commentUi: {},
  responseContents: {},
  responseUserTexts: {},
  responseErrors: {},
  pendingRequestIds: {},
  scrollPositions: {},
};

const sidebarEl = document.getElementById('sidebar');
const sessionLabelEl = document.getElementById('session-label');
const summaryEl = document.getElementById('summary');
const toggleSidebarButton = document.getElementById('toggle-sidebar-button');
const sidebarSearchInputEl = document.getElementById('sidebar-search-input');
const responseListEl = document.getElementById('response-list');
const currentResponseLabelEl = document.getElementById(
  'current-response-label',
);
const responseMetaEl = document.getElementById('response-meta');
const modeHintEl = document.getElementById('mode-hint');
const editorContainerEl = document.getElementById('editor-container');
const responseCommentsContainer = document.getElementById(
  'response-comments-container',
);
const overallCommentButton = document.getElementById('overall-comment-button');
const toggleWrapButton = document.getElementById('toggle-wrap-button');
const cancelButton = document.getElementById('cancel-button');
const submitButton = document.getElementById('submit-button');

sessionLabelEl.textContent =
  reviewData.session?.sessionPath || reviewData.session?.displayTitle || '';

document.getElementById('window-title').textContent =
  `Response review · ${reviewData.session?.displayTitle || 'session'}`;

let monacoApi = null;
let editor = null;
let model = null;
let decorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let hoverDecoration = [];
let requestSequence = 0;
const pendingHostRequests = new Map();
let selectionWidget = null;
let pendingGutterClickTimer = null;
let hasInitializedEditorCursor = false;
let isNormalizingEditorSelection = false;
let shouldOpenCommentOnArrowNavigation = false;

const DEBUG_STORAGE_KEY = 'response-review-debug';
const debugState = {
  enabled: false,
  lines: [],
  panel: null,
  pre: null,
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nextRequestId(prefix) {
  requestSequence += 1;
  return `${prefix}:${Date.now()}:${requestSequence}`;
}

function sendHostRequest(message, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : 2000;
  return new Promise(resolve => {
    let settled = false;
    let timeoutId = null;

    const finish = result => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      pendingHostRequests.delete(message.requestId);
      resolve(result);
    };

    pendingHostRequests.set(message.requestId, finish);
    debugLog('host request dispatch begin', {
      type: message.type,
      requestId: message.requestId,
      timeoutMs,
    });

    timeoutId = window.setTimeout(() => {
      debugLog('host request timed out', {
        type: message.type,
        requestId: message.requestId,
        timeoutMs,
      });
      finish({
        type: `${message.type}-timeout`,
        requestId: message.requestId,
        ok: false,
        message: `Timed out waiting for host ${message.type}`,
      });
    }, timeoutMs);

    try {
      window.glimpse.send(message);
      debugLog('host request dispatch returned', {
        type: message.type,
        requestId: message.requestId,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      debugLog('host request dispatch threw', {
        type: message.type,
        requestId: message.requestId,
        error: errorText,
      });
      finish({
        type: `${message.type}-error`,
        requestId: message.requestId,
        ok: false,
        message: errorText,
      });
    }
  });
}

function getStoredDebugEnabled() {
  try {
    return window.localStorage?.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function serializeDebugDetails(details) {
  if (details === null || details === undefined) return '';
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

function ensureDebugPanel() {
  if (debugState.panel !== null) return;
  const panel = document.createElement('div');
  panel.style.position = 'fixed';
  panel.style.right = '12px';
  panel.style.bottom = '12px';
  panel.style.width = '460px';
  panel.style.maxWidth = 'calc(100vw - 24px)';
  panel.style.maxHeight = '220px';
  panel.style.display = 'none';
  panel.style.zIndex = '9999';
  panel.style.border = '1px solid #30363d';
  panel.style.borderRadius = '8px';
  panel.style.background = 'rgba(1, 4, 9, 0.96)';
  panel.style.boxShadow = '0 12px 40px rgba(0,0,0,0.45)';
  panel.style.overflow = 'hidden';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.padding = '6px 10px';
  header.style.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  header.style.color = '#c9d1d9';
  header.style.background = '#161b22';
  header.textContent = 'response-review debug (Ctrl/Cmd+Shift+D to toggle)';

  const pre = document.createElement('pre');
  pre.style.margin = '0';
  pre.style.padding = '8px 10px';
  pre.style.font = '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace';
  pre.style.color = '#8b949e';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.overflow = 'auto';
  pre.style.maxHeight = '180px';

  panel.appendChild(header);
  panel.appendChild(pre);
  document.body.appendChild(panel);
  debugState.panel = panel;
  debugState.pre = pre;
}

function renderDebugPanel() {
  ensureDebugPanel();
  if (debugState.panel === null || debugState.pre === null) return;
  debugState.panel.style.display = debugState.enabled ? 'block' : 'none';
  debugState.pre.textContent = debugState.lines.join('\n');
  debugState.pre.scrollTop = debugState.pre.scrollHeight;
}

function setDebugEnabled(enabled) {
  debugState.enabled = enabled;
  try {
    if (enabled) window.localStorage?.setItem(DEBUG_STORAGE_KEY, '1');
    else window.localStorage?.removeItem(DEBUG_STORAGE_KEY);
  } catch {
    // Ignore localStorage failures.
  }
  if (enabled) {
    debugState.lines.push('debug enabled');
    debugState.lines = debugState.lines.slice(-80);
  }
  renderDebugPanel();
}

function debugLog(message, details) {
  if (!debugState.enabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${message}${serializeDebugDetails(details)}`;
  debugState.lines.push(line);
  debugState.lines = debugState.lines.slice(-80);
  console.log(line);
  renderDebugPanel();
}

function normalizeQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;
    if (i === previousMatchIndex + 1) score += 8;

    const previousChar = i > 0 ? candidate[i - 1] : '';
    if (
      i === 0 ||
      previousChar === ' ' ||
      previousChar === '/' ||
      previousChar === '#' ||
      previousChar === ':'
    ) {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function responseSearchText(response) {
  return [
    `response #${response.index}`,
    response.preview,
    response.precedingUserPreview,
    response.provider || '',
    response.model || '',
  ]
    .join(' ')
    .toLowerCase();
}

function getResponseSearchScore(query, response) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;
  const text = responseSearchText(response);
  const score = scoreSubsequence(normalizedQuery, text.replace(/\s+/g, ''));
  if (score < 0) return -1;
  if (text.includes(query.toLowerCase().trim())) return score + 40;
  return score;
}

function getFilteredResponses() {
  const query = state.search.trim();
  if (!query) return [...allResponses];
  return allResponses
    .map(response => ({
      response,
      score: getResponseSearchScore(query, response),
    }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.response.index - a.response.index;
    })
    .map(entry => entry.response);
}

function ensureDraft(responseId) {
  if (!responseId) return null;
  if (!state.drafts[responseId]) {
    state.drafts[responseId] = {
      overallComment: '',
      comments: [],
    };
  }
  return state.drafts[responseId];
}

function getDraft(responseId = state.activeResponseId) {
  return ensureDraft(responseId);
}

function getCommentUi(commentId) {
  if (!state.commentUi[commentId]) {
    state.commentUi[commentId] = {
      collapsed: false,
    };
  }
  return state.commentUi[commentId];
}

function isCommentCollapsed(commentId) {
  return getCommentUi(commentId).collapsed === true;
}

function activeResponse() {
  return state.activeResponseId
    ? responseById.get(state.activeResponseId) || null
    : null;
}

function activeDraft() {
  return getDraft(state.activeResponseId);
}

function commentCount(responseId) {
  const draft = getDraft(responseId);
  return draft ? draft.comments.length : 0;
}

function totalCommentCount() {
  return Object.values(state.drafts).reduce(
    (sum, draft) => sum + (draft?.comments?.length || 0),
    0,
  );
}

function hasActiveFeedback() {
  const draft = activeDraft();
  if (!draft) return false;
  if (draft.overallComment.trim().length > 0) return true;
  return draft.comments.some(comment => comment.body.trim().length > 0);
}

function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

function modelLabel(response) {
  if (!response) return '';
  if (response.provider && response.model)
    return `${response.provider}/${response.model}`;
  return response.model || response.provider || 'unknown model';
}

function activeMetaText(response) {
  if (!response) return '';
  const parts = [
    `Response #${response.index}`,
    formatDate(response.timestamp),
    `${response.lineCount} line${response.lineCount === 1 ? '' : 's'}`,
    modelLabel(response),
  ];
  if (response.precedingUserPreview) {
    parts.push(`prompt: ${response.precedingUserPreview}`);
  }
  return parts.filter(Boolean).join(' • ');
}

function ensureActiveResponse() {
  if (state.activeResponseId && responseById.has(state.activeResponseId))
    return;
  state.activeResponseId = allResponses[0]?.id ?? null;
}

function getSelectionLineRange() {
  if (!editor) return null;
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return null;

  const startLine = Math.max(1, selection.startLineNumber);
  let endLine = Math.max(startLine, selection.endLineNumber);
  if (selection.endColumn === 1 && endLine > startLine) {
    endLine -= 1;
  }

  return {
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
  };
}

function getActiveCommentTarget() {
  if (!editor || !model || !isActiveResponseReady()) return null;
  const selection = editor.getSelection();
  if (!selection) return null;

  const selectionRange = getSelectionLineRange();
  if (selectionRange !== null) {
    const existingComment = findInlineCommentOverlappingRange(
      selectionRange.startLine,
      selectionRange.endLine,
    );
    if (existingComment) {
      const endLine = existingComment.endLine || existingComment.startLine;
      return {
        startLine: existingComment.startLine,
        endLine,
        lineCount: endLine - existingComment.startLine + 1,
        lineNumber: endLine,
        column: model.getLineMaxColumn(endLine),
        mode: 'existing',
        commentId: existingComment.id,
      };
    }
    return {
      startLine: selectionRange.startLine,
      endLine: selectionRange.endLine,
      lineCount: selectionRange.lineCount,
      lineNumber: selectionRange.endLine,
      column: model.getLineMaxColumn(selectionRange.endLine),
      mode: 'selection',
    };
  }

  const lineNumber = Math.max(
    1,
    selection.positionLineNumber ?? selection.endLineNumber,
  );
  const existingComment = findInlineCommentCoveringLine(lineNumber);
  if (existingComment) {
    const endLine = existingComment.endLine || existingComment.startLine;
    return {
      startLine: existingComment.startLine,
      endLine,
      lineCount: endLine - existingComment.startLine + 1,
      lineNumber: endLine,
      column: model.getLineMaxColumn(endLine),
      mode: 'existing',
      commentId: existingComment.id,
    };
  }

  return {
    startLine: lineNumber,
    endLine: lineNumber,
    lineCount: 1,
    lineNumber,
    column: model.getLineMaxColumn(lineNumber),
    mode: 'cursor',
  };
}

function normalizeEditorSelectionToWholeLines() {
  if (!editor || !model || !monacoApi || isNormalizingEditorSelection)
    return false;
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return false;

  const selectionRange = getSelectionLineRange();
  if (!selectionRange) return false;

  const normalizedSelection = new monacoApi.Selection(
    selectionRange.startLine,
    1,
    selectionRange.endLine,
    model.getLineMaxColumn(selectionRange.endLine),
  );

  if (
    selection.startLineNumber === normalizedSelection.startLineNumber &&
    selection.startColumn === normalizedSelection.startColumn &&
    selection.endLineNumber === normalizedSelection.endLineNumber &&
    selection.endColumn === normalizedSelection.endColumn
  ) {
    return false;
  }

  isNormalizingEditorSelection = true;
  try {
    editor.setSelection(normalizedSelection);
  } finally {
    isNormalizingEditorSelection = false;
  }
  return true;
}

function getSelectionWidgetPosition() {
  if (!editor || !monacoApi || !isActiveResponseReady()) return null;
  const target = getActiveCommentTarget();
  if (target === null) return null;

  return {
    position: {lineNumber: target.lineNumber, column: target.column},
    preference: [
      monacoApi.editor.ContentWidgetPositionPreference.EXACT,
      monacoApi.editor.ContentWidgetPositionPreference.BELOW,
      monacoApi.editor.ContentWidgetPositionPreference.ABOVE,
    ],
  };
}

function ensureSelectionWidget() {
  if (!editor || !monacoApi || selectionWidget !== null) return;

  const domNode = document.createElement('button');
  domNode.type = 'button';
  domNode.className =
    'inline-flex h-4 w-4 items-center justify-center rounded-[4px] border border-[rgba(240,246,252,0.08)] bg-[#238636] p-0 text-[12px] font-semibold leading-none text-white shadow-lg hover:bg-[#2ea043]';
  domNode.style.marginLeft = '6px';
  domNode.setAttribute('aria-label', 'Add note');
  domNode.textContent = '+';
  wireCommentInput(domNode);
  domNode.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const target = getActiveCommentTarget();
    if (target === null) return;
    addInlineComment(target.startLine, target.endLine);
  });

  selectionWidget = {
    getId() {
      return 'response-review-selection-widget';
    },
    getDomNode() {
      return domNode;
    },
    getPosition() {
      return getSelectionWidgetPosition();
    },
  };

  editor.addContentWidget(selectionWidget);
}

function updateSelectionWidget() {
  if (!editor || selectionWidget === null) return;
  const target = getActiveCommentTarget();
  const visible = target !== null && isActiveResponseReady();
  const domNode = selectionWidget.getDomNode();
  domNode.style.display = visible ? 'inline-flex' : 'none';
  if (visible) {
    domNode.textContent = '+';
    domNode.title =
      target.mode === 'existing'
        ? `Open note for ${lineRangeLabel(target)}`
        : target.mode === 'selection'
          ? `Add note for ${target.lineCount} selected line${target.lineCount === 1 ? '' : 's'}`
          : `Add note for line ${target.startLine}`;
  }
  editor.layoutContentWidget(selectionWidget);
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? '0px' : '340px';
  sidebarEl.style.minWidth = collapsed ? '0px' : '340px';
  sidebarEl.style.flexBasis = collapsed ? '0px' : '340px';
  sidebarEl.style.borderRightWidth = collapsed ? '0px' : '1px';
  sidebarEl.style.pointerEvents = collapsed ? 'none' : 'auto';
  toggleSidebarButton.textContent = collapsed ? 'Show sidebar' : 'Hide sidebar';
}

function updateButtons() {
  const response = activeResponse();
  const draft = activeDraft();
  overallCommentButton.textContent = draft?.overallComment?.trim()
    ? 'Overall note ✓'
    : 'Overall note';
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? 'on' : 'off'}`;
  overallCommentButton.disabled = !response;
  submitButton.disabled = !response || !hasActiveFeedback();
}

function modeHintText(active, commentTarget) {
  if (!active) return 'Select a response to start reviewing.';
  if (commentTarget?.mode === 'existing') {
    return `${lineRangeLabel(commentTarget)} already has a note. Press Enter or click the green + button to open it.`;
  }
  if (commentTarget?.mode === 'selection') {
    return `Selections snap to whole lines. Use the green + button or gutter to add a note for ${commentTarget.lineCount} selected line${commentTarget.lineCount === 1 ? '' : 's'}.`;
  }
  if (commentTarget !== null && commentTarget !== undefined) {
    return 'The green + button adds a note for the current line. Selections snap to whole lines.';
  }
  return 'Hover or click the gutter to comment on a line.';
}

function renderSidebar() {
  ensureActiveResponse();
  responseListEl.innerHTML = '';
  const visible = getFilteredResponses();

  if (visible.length === 0) {
    const query = state.search.trim();
    responseListEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${query ? `No responses match <span class="text-review-text">${escapeHtml(query)}</span>.` : 'No reviewable responses found.'}
      </div>
    `;
  } else {
    visible.forEach(response => {
      const active = response.id === state.activeResponseId;
      const count = commentCount(response.id);
      const pending =
        state.pendingRequestIds[response.id] !== null &&
        state.pendingRequestIds[response.id] !== undefined &&
        state.responseContents[response.id] === undefined;
      const errored =
        state.responseErrors[response.id] !== null &&
        state.responseErrors[response.id] !== undefined;
      const indicatorClass = errored
        ? 'text-red-400'
        : pending
          ? 'text-[#58a6ff]'
          : count > 0
            ? 'text-[#3fb950]'
            : 'text-transparent';
      const indicatorText = errored ? '!' : pending ? '…' : '●';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = [
        'group mb-2 flex w-full flex-col gap-1 rounded-md border px-3 py-3 text-left',
        active
          ? 'border-[#58a6ff]/40 bg-[#1f2937] text-white'
          : 'border-review-border bg-[#0f141a] text-review-text hover:bg-[#161b22]',
      ].join(' ');
      button.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-[10px] ${indicatorClass}">${indicatorText}</span>
            <span class="truncate text-[12px] font-semibold">Response #${response.index}</span>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#11161d] px-1 text-[10px] font-medium text-review-text">${count}</span>` : ''}
            <span class="text-[10px] text-review-muted">${response.lineCount}L</span>
          </div>
        </div>
        <div class="truncate text-[12px] ${active ? 'text-white' : 'text-review-text'}">${escapeHtml(response.preview || '(empty response)')}</div>
        <div class="truncate text-[11px] ${active ? 'text-[#c9d1d9]' : 'text-review-muted'}">${escapeHtml(response.precedingUserPreview || modelLabel(response))}</div>
        <div class="flex items-center justify-between gap-2 text-[10px] text-review-muted">
          <span class="truncate">${escapeHtml(modelLabel(response))}</span>
          <span class="shrink-0">${escapeHtml(formatDate(response.timestamp))}</span>
        </div>
      `;
      button.addEventListener('click', () => openResponse(response.id));
      responseListEl.appendChild(button);
    });
  }

  const active = activeResponse();
  const activeDraftRef = activeDraft();
  summaryEl.textContent = `${allResponses.length} response(s) • ${totalCommentCount()} comment draft(s)${activeDraftRef?.overallComment?.trim() ? ' • overall note on selected response' : ''}${state.search.trim() ? ` • ${visible.length} shown` : ''}`;
  currentResponseLabelEl.textContent = active
    ? `Response #${active.index}`
    : 'No response selected';
  responseMetaEl.textContent = activeMetaText(active);
  const commentTarget =
    active !== null && isActiveResponseReady()
      ? getActiveCommentTarget()
      : null;
  modeHintEl.textContent = modeHintText(active, commentTarget);
  updateButtons();
  updateSidebarLayout();
}

function scrollKey(responseId) {
  return `response:${responseId}`;
}

function saveCurrentScrollPosition() {
  if (!editor || !state.activeResponseId) return;
  state.scrollPositions[scrollKey(state.activeResponseId)] = {
    top: editor.getScrollTop(),
    left: editor.getScrollLeft(),
  };
}

function restoreScrollPosition() {
  if (!editor || !state.activeResponseId) return;
  const scrollState = state.scrollPositions[scrollKey(state.activeResponseId)];
  if (!scrollState) return;
  editor.setScrollTop(scrollState.top);
  editor.setScrollLeft(scrollState.left);
}

function requestState(responseId) {
  return {
    text: state.responseContents[responseId],
    userText: state.responseUserTexts[responseId],
    error: state.responseErrors[responseId],
    requestId: state.pendingRequestIds[responseId],
  };
}

function ensureResponseLoaded(responseId) {
  if (!responseId) return;
  const current = requestState(responseId);
  if (
    (current.text !== null && current.text !== undefined) ||
    (current.error !== null && current.error !== undefined) ||
    (current.requestId !== null && current.requestId !== undefined)
  ) {
    return;
  }
  const requestId = nextRequestId('request');
  state.pendingRequestIds[responseId] = requestId;
  renderSidebar();
  if (window.glimpse?.send) {
    window.glimpse.send({type: 'request-response', requestId, responseId});
  }
}

function openResponse(responseId) {
  if (state.activeResponseId === responseId) {
    ensureResponseLoaded(responseId);
    return;
  }
  saveCurrentScrollPosition();
  state.activeResponseId = responseId;
  renderAll({restoreScroll: true});
  ensureResponseLoaded(responseId);
}

function showTextModal(options) {
  const backdrop = document.createElement('div');
  backdrop.className = 'review-modal-backdrop';
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue || '')}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel || 'Save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector('#review-modal-text');
  const close = () => backdrop.remove();
  backdrop
    .querySelector('#review-modal-cancel')
    .addEventListener('click', close);
  backdrop.querySelector('#review-modal-save').addEventListener('click', () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showConfirmModal(options) {
  const confirmClassName =
    options.confirmTone === 'danger'
      ? 'cursor-pointer rounded-md border border-red-500/20 bg-red-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500'
      : 'cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]';

  const backdrop = document.createElement('div');
  backdrop.className = 'review-modal-backdrop';
  backdrop.innerHTML = `
    <div class="review-modal-card" tabindex="-1">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">${escapeHtml(options.cancelLabel || 'Cancel')}</button>
        <button id="review-modal-confirm" class="${confirmClassName}">${escapeHtml(options.confirmLabel || 'Confirm')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const confirmButton = backdrop.querySelector('#review-modal-confirm');
  const cancelButton = backdrop.querySelector('#review-modal-cancel');
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
  };

  const cancel = () => {
    close();
    options.onCancel?.();
  };

  const confirm = () => {
    close();
    options.onConfirm?.();
  };

  cancelButton.addEventListener('click', cancel);
  confirmButton.addEventListener('click', confirm);
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) cancel();
  });
  backdrop.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        confirm();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    },
    true,
  );

  confirmButton.focus();
}

function showOverallCommentModal() {
  const response = activeResponse();
  const draft = activeDraft();
  if (!response || !draft) return;
  showTextModal({
    title: `Overall note for response #${response.index}`,
    description:
      'This note is included above the line-targeted review comments in the generated prompt.',
    initialValue: draft.overallComment,
    saveLabel: 'Save note',
    onSave: value => {
      draft.overallComment = value;
      renderSidebar();
    },
  });
}

function lineRangeLabel(comment) {
  if (comment.startLine === null || comment.startLine === undefined) {
    return 'Whole response';
  }
  if (
    comment.endLine !== null &&
    comment.endLine !== undefined &&
    comment.endLine !== comment.startLine
  ) {
    return `Lines ${comment.startLine}-${comment.endLine}`;
  }
  return `Line ${comment.startLine}`;
}

function normalizeInlineCommentRange(startLine, endLine) {
  const safeStartLine = Math.max(1, Math.min(startLine, endLine || startLine));
  const safeEndLine = Math.max(
    safeStartLine,
    Math.max(startLine, endLine || startLine),
  );
  return {
    startLine: safeStartLine,
    endLine: safeEndLine,
    lineCount: safeEndLine - safeStartLine + 1,
  };
}

function inlineCommentLineEnd(comment) {
  return comment.endLine || comment.startLine;
}

function getInlineComments(draft = activeDraft()) {
  if (!draft) return [];
  return draft.comments.filter(
    comment => comment.startLine !== null && comment.startLine !== undefined,
  );
}

function lineRangesOverlap(startLineA, endLineA, startLineB, endLineB) {
  return startLineA <= endLineB && startLineB <= endLineA;
}

function findInlineCommentCoveringLine(lineNumber, draft = activeDraft()) {
  return (
    getInlineComments(draft).find(comment => {
      const endLine = inlineCommentLineEnd(comment);
      return lineNumber >= comment.startLine && lineNumber <= endLine;
    }) || null
  );
}

function findInlineCommentOverlappingRange(
  startLine,
  endLine,
  draft = activeDraft(),
) {
  const normalizedRange = normalizeInlineCommentRange(startLine, endLine);
  return (
    getInlineComments(draft).find(comment =>
      lineRangesOverlap(
        normalizedRange.startLine,
        normalizedRange.endLine,
        comment.startLine,
        inlineCommentLineEnd(comment),
      ),
    ) || null
  );
}

function findCommentTextarea(commentId) {
  return (
    [...document.querySelectorAll('textarea[data-comment-id]')].find(
      textarea => textarea.getAttribute('data-comment-id') === commentId,
    ) || null
  );
}

function captureTextareaSelection(textarea) {
  return {
    start: textarea.selectionStart ?? 0,
    end: textarea.selectionEnd ?? textarea.selectionStart ?? 0,
    direction: textarea.selectionDirection || 'none',
  };
}

function focusCommentTextarea(textarea, options = {}) {
  textarea.focus();
  const maxOffset = textarea.value.length;
  const start = Math.max(
    0,
    Math.min(
      Number.isFinite(options.start) ? Number(options.start) : maxOffset,
      maxOffset,
    ),
  );
  const end = Math.max(
    start,
    Math.min(
      Number.isFinite(options.end) ? Number(options.end) : start,
      maxOffset,
    ),
  );
  textarea.setSelectionRange(start, end, options.direction || 'none');
  logTextareaSelection(textarea, 'comment textarea focused', {
    start,
    end,
    direction: options.direction || 'none',
  });
}

function focusCommentTextareaAtEnd(textarea) {
  const caret = textarea.value.length;
  focusCommentTextarea(textarea, {start: caret, end: caret, direction: 'none'});
  logTextareaSelection(textarea, 'comment textarea focused at end');
}

function scheduleFocusCommentInput(commentId, options = {}) {
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Number(options.maxAttempts)
    : 12;
  let attempts = 0;

  const tryFocus = () => {
    const textarea = findCommentTextarea(commentId);
    if (textarea === null) {
      if (attempts >= maxAttempts) return;
      attempts += 1;
      requestAnimationFrame(tryFocus);
      return;
    }

    if (editor && Number.isFinite(options.revealLineNumber)) {
      editor.revealLineInCenter(Number(options.revealLineNumber));
    }
    focusCommentTextareaAtEnd(textarea);
  };

  requestAnimationFrame(tryFocus);
}

function expandAndFocusInlineComment(comment, options = {}) {
  if (comment.startLine === null || comment.startLine === undefined) return;
  const revealLineNumber = inlineCommentLineEnd(comment);
  const textarea = findCommentTextarea(comment.id);

  if (!isCommentCollapsed(comment.id) && textarea !== null) {
    if (editor) editor.revealLineInCenter(revealLineNumber);
    focusCommentTextareaAtEnd(textarea);
    return;
  }

  getCommentUi(comment.id).collapsed = false;
  renderAll({preserveScroll: options.preserveScroll !== false});
  scheduleFocusCommentInput(comment.id, {revealLineNumber});
}

function getActiveResponseText() {
  if (!state.activeResponseId) return null;
  return state.responseContents[state.activeResponseId] || null;
}

function getExcerptForRange(text, startLine, endLine) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.max(safeStart, endLine || startLine);
  return lines.slice(safeStart - 1, safeEnd).join('\n');
}

function addInlineComment(startLine, endLine) {
  const response = activeResponse();
  const draft = activeDraft();
  const text = getActiveResponseText();
  if (!response || !draft || text === null) return;

  const normalizedRange = normalizeInlineCommentRange(startLine, endLine);
  const existingComment = findInlineCommentOverlappingRange(
    normalizedRange.startLine,
    normalizedRange.endLine,
    draft,
  );
  if (existingComment) {
    expandAndFocusInlineComment(existingComment);
    return;
  }

  const comment = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    responseId: response.id,
    startLine: normalizedRange.startLine,
    endLine: normalizedRange.endLine,
    excerpt: getExcerptForRange(
      text,
      normalizedRange.startLine,
      normalizedRange.endLine,
    ),
    body: '',
  };
  draft.comments.push(comment);
  renderAll({preserveScroll: true});
  scheduleFocusCommentInput(comment.id, {
    revealLineNumber: inlineCommentLineEnd(comment),
  });
}

function clearViewZones() {
  if (!editor || activeViewZones.length === 0) return;
  editor.changeViewZones(accessor => {
    activeViewZones.forEach(zoneEntry => accessor.removeZone(zoneEntry.id));
  });
  activeViewZones = [];
}

function captureEditorSelectionSnapshot() {
  if (!editor) return null;
  const selection = editor.getSelection();
  if (!selection) return null;
  return {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber,
    endColumn: selection.endColumn,
  };
}

function restoreEditorSelectionSnapshot(snapshot) {
  if (!editor || !monacoApi || !snapshot) return;
  const selection = new monacoApi.Selection(
    snapshot.startLineNumber,
    snapshot.startColumn,
    snapshot.endLineNumber,
    snapshot.endColumn,
  );
  editor.focus();
  editor.setSelection(selection);
  editor.setPosition({
    lineNumber: selection.positionLineNumber,
    column: selection.positionColumn,
  });
  editor.revealLineInCenter(selection.positionLineNumber);
  updateSelectionWidget();
}

function moveEditorCursorToLine(lineNumber) {
  if (!editor || !model || !monacoApi) return;
  const clampedLine = Math.max(1, Math.min(lineNumber, model.getLineCount()));
  editor.focus();
  editor.setPosition({lineNumber: clampedLine, column: 1});
  editor.setSelection(new monacoApi.Selection(clampedLine, 1, clampedLine, 1));
  editor.revealLineInCenter(clampedLine);
  updateSelectionWidget();
}

function maybeOpenCommentForActiveEditorLine(options = {}) {
  if (!editor) return;
  const lineNumber =
    editor.getPosition()?.lineNumber ??
    editor.getSelection()?.positionLineNumber ??
    null;
  if (!Number.isFinite(lineNumber)) return;
  const comment = findInlineCommentCoveringLine(Number(lineNumber));
  if (!comment || comment.id === options.excludeCommentId) return;
  expandAndFocusInlineComment(comment);
}

function deleteComment(comment, options = {}) {
  const draft = activeDraft();
  if (!draft) return;
  draft.comments = draft.comments.filter(item => item.id !== comment.id);
  renderAll({preserveScroll: options.preserveScroll !== false});
  if (Number.isFinite(options.focusLine)) {
    requestAnimationFrame(() => {
      moveEditorCursorToLine(Number(options.focusLine));
    });
  }
}

function collapseComment(comment, options = {}) {
  const nextLine = Math.max(
    comment.startLine ?? 1,
    (comment.endLine ?? comment.startLine ?? 1) + 1,
  );
  const targetLine = Number.isFinite(options.targetLine)
    ? Number(options.targetLine)
    : nextLine;
  getCommentUi(comment.id).collapsed = true;
  renderAll({preserveScroll: true});
  if (options.moveCursor !== false) {
    requestAnimationFrame(() => {
      moveEditorCursorToLine(targetLine);
      if (options.openCommentOnArrival !== false) {
        maybeOpenCommentForActiveEditorLine({excludeCommentId: comment.id});
      }
    });
  }
}

function stopEditorEventPropagation(event) {
  event.stopPropagation();
}

function stopEditorKeyboardEvent(event) {
  const key = String(event.key || '').toLowerCase();
  const isModifierShortcut =
    (event.metaKey || event.ctrlKey) &&
    ['a', 'c', 'v', 'x', 'z', 'y', 'enter'].includes(key);

  if (isModifierShortcut) {
    event.stopPropagation();
    return;
  }
  event.stopPropagation();
}

function wireCommentInput(element) {
  element.addEventListener('keydown', stopEditorKeyboardEvent);
  element.addEventListener('keyup', stopEditorKeyboardEvent);
  ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'wheel'].forEach(
    eventName => {
      element.addEventListener(eventName, stopEditorEventPropagation);
    },
  );
}

function logTextareaSelection(textarea, reason, extraDetails = {}) {
  debugLog(reason, {
    valueLength: textarea.value.length,
    selectionStart: textarea.selectionStart ?? null,
    selectionEnd: textarea.selectionEnd ?? null,
    activeTag: document.activeElement?.tagName ?? null,
    ...extraDetails,
  });
}

function dispatchTextareaInput(textarea) {
  textarea.dispatchEvent(new Event('input', {bubbles: true}));
  logTextareaSelection(textarea, 'textarea input dispatched');
}

function installTextareaShortcutFallback(textarea) {
  let pendingClipboardAction = null;
  let pendingFlushTimer = null;
  let modifierState = {meta: false, ctrl: false};

  const clearPendingFlushTimer = () => {
    if (pendingFlushTimer !== null) {
      window.clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
  };

  const requestPrefixForAction = action => {
    if (action.kind === 'read') return 'paste';
    return action.key === 'x' ? 'cut' : 'copy';
  };

  const flushPendingClipboardAction = (reason, options = {}) => {
    const action = pendingClipboardAction;
    if (!action || action.inFlight) return;

    const allowWhileModifierHeld = options.allowWhileModifierHeld === true;
    if ((modifierState.meta || modifierState.ctrl) && !allowWhileModifierHeld) {
      debugLog('textarea clipboard flush waiting for modifier release', {
        reason,
        pendingKey: action.key,
        modifierState: {...modifierState},
      });
      clearPendingFlushTimer();
      pendingFlushTimer = window.setTimeout(
        () => flushPendingClipboardAction('timer'),
        75,
      );
      return;
    }

    clearPendingFlushTimer();
    action.inFlight = true;
    const requestId = nextRequestId(requestPrefixForAction(action));
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : allowWhileModifierHeld
        ? 300
        : 2000;

    if (action.kind === 'write') {
      debugLog('textarea host clipboard write requested', {
        key: action.key,
        requestId,
        reason,
        allowWhileModifierHeld,
        timeoutMs,
      });
      void sendHostRequest(
        {
          type: 'clipboard-write',
          requestId,
          text: action.text,
        },
        {timeoutMs},
      ).then(result => {
        if (pendingClipboardAction !== action) return;
        action.inFlight = false;
        debugLog('textarea host clipboard write result', {
          key: action.key,
          requestId,
          result,
        });
        if (result?.ok) {
          pendingClipboardAction = null;
          if (action.key === 'x') {
            textarea.setRangeText(
              '',
              action.selectionStart,
              action.selectionEnd,
              'start',
            );
            dispatchTextareaInput(textarea);
          }
          return;
        }
        if (
          allowWhileModifierHeld &&
          !action.didRetryAfterModifierRelease &&
          !(modifierState.meta || modifierState.ctrl)
        ) {
          action.didRetryAfterModifierRelease = true;
          debugLog(
            'textarea host clipboard write retrying after modifier release',
            {key: action.key},
          );
          flushPendingClipboardAction('retry-after-modifier-release');
          return;
        }
        if (
          !allowWhileModifierHeld ||
          !(modifierState.meta || modifierState.ctrl)
        ) {
          debugLog('textarea host clipboard write abandoned', {
            key: action.key,
            requestId,
          });
          pendingClipboardAction = null;
        }
      });
      return;
    }

    debugLog('textarea host clipboard read requested', {
      requestId,
      reason,
      allowWhileModifierHeld,
      timeoutMs,
    });
    void sendHostRequest(
      {
        type: 'clipboard-read',
        requestId,
      },
      {timeoutMs},
    ).then(result => {
      if (pendingClipboardAction !== action) return;
      action.inFlight = false;
      debugLog('textarea host clipboard read result', {requestId, result});
      if (result?.ok && typeof result.text === 'string') {
        pendingClipboardAction = null;
        textarea.setRangeText(
          result.text,
          action.selectionStart,
          action.selectionEnd,
          'end',
        );
        dispatchTextareaInput(textarea);
        return;
      }
      if (
        allowWhileModifierHeld &&
        !action.didRetryAfterModifierRelease &&
        !(modifierState.meta || modifierState.ctrl)
      ) {
        action.didRetryAfterModifierRelease = true;
        debugLog(
          'textarea host clipboard read retrying after modifier release',
          {},
        );
        flushPendingClipboardAction('retry-after-modifier-release');
        return;
      }
      if (
        !allowWhileModifierHeld ||
        !(modifierState.meta || modifierState.ctrl)
      ) {
        debugLog('textarea host clipboard read abandoned', {requestId});
        pendingClipboardAction = null;
      }
    });
  };

  const queueClipboardAction = action => {
    pendingClipboardAction = {
      ...action,
      inFlight: false,
      didRetryAfterModifierRelease: false,
    };
    clearPendingFlushTimer();
    pendingFlushTimer = window.setTimeout(() => {
      flushPendingClipboardAction('initial-timer-force', {
        allowWhileModifierHeld: true,
        timeoutMs: 300,
      });
    }, 125);
  };

  const handleShortcutKeyup = (event, source) => {
    modifierState = {meta: event.metaKey, ctrl: event.ctrlKey};
    const key = String(event.key || '').toLowerCase();
    debugLog(`${source} modifier keyup:${key}`, {
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    });
    if (!pendingClipboardAction) return;
    if (key === pendingClipboardAction.key) {
      flushPendingClipboardAction(`${source}-keyup-action-key`, {
        allowWhileModifierHeld: true,
        timeoutMs: 300,
      });
      return;
    }
    if (!['meta', 'control'].includes(key)) return;
    flushPendingClipboardAction(`${source}-keyup-modifier`);
  };

  const handleWindowKeyupCapture = event => {
    if (document.activeElement !== textarea) return;
    handleShortcutKeyup(event, 'window-capture');
  };

  textarea.addEventListener('focus', () => {
    logTextareaSelection(textarea, 'textarea focus');
    window.addEventListener('keyup', handleWindowKeyupCapture, true);
  });
  textarea.addEventListener('blur', () => {
    window.removeEventListener('keyup', handleWindowKeyupCapture, true);
    modifierState = {meta: false, ctrl: false};
    debugLog('textarea blur', {
      activeTag: document.activeElement?.tagName ?? null,
    });
    flushPendingClipboardAction('blur');
  });

  textarea.addEventListener('keydown', event => {
    modifierState = {meta: event.metaKey, ctrl: event.ctrlKey};
    const key = String(event.key || '').toLowerCase();
    const hasModifier = event.metaKey || event.ctrlKey;
    if (!hasModifier || event.altKey) return;

    logTextareaSelection(textarea, `textarea modifier keydown:${key}`);

    if (key === 'a') {
      event.preventDefault();
      event.stopPropagation();
      textarea.select();
      logTextareaSelection(textarea, 'textarea select-all handled');
      return;
    }

    if (key === 'c' || key === 'x') {
      const selectionStart = textarea.selectionStart ?? 0;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const selectedText = textarea.value.slice(selectionStart, selectionEnd);
      if (selectedText.length === 0) {
        debugLog('textarea host copy/cut skipped', {
          key,
          reason: 'empty selection',
        });
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      debugLog('textarea host clipboard write queued', {
        key,
        selectionLength: selectedText.length,
      });
      queueClipboardAction({
        kind: 'write',
        key,
        text: selectedText,
        selectionStart,
        selectionEnd,
      });
      return;
    }

    if (key === 'v') {
      event.preventDefault();
      event.stopPropagation();
      const selectionStart = textarea.selectionStart ?? 0;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      debugLog('textarea host clipboard read queued', {
        selectionStart,
        selectionEnd,
      });
      queueClipboardAction({
        kind: 'read',
        key,
        selectionStart,
        selectionEnd,
      });
    }
  });

  textarea.addEventListener('keyup', event => {
    handleShortcutKeyup(event, 'textarea');
  });
}

function autosizeCommentTextarea(textarea) {
  const computedStyle = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 20;
  const verticalPadding =
    (Number.parseFloat(computedStyle.paddingTop) || 0) +
    (Number.parseFloat(computedStyle.paddingBottom) || 0) +
    (Number.parseFloat(computedStyle.borderTopWidth) || 0) +
    (Number.parseFloat(computedStyle.borderBottomWidth) || 0);
  const minLines = 2;
  const maxLines = 8;

  const previousHeight =
    Number.parseFloat(textarea.style.height || '0') ||
    textarea.getBoundingClientRect().height;
  textarea.style.height = 'auto';
  const contentLines = Math.max(
    1,
    Math.ceil((textarea.scrollHeight - verticalPadding) / lineHeight),
  );
  const targetLines = Math.max(minLines, Math.min(maxLines, contentLines));
  const nextHeight = Math.round(targetLines * lineHeight + verticalPadding);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.minHeight = `${Math.round(minLines * lineHeight + verticalPadding)}px`;
  textarea.style.overflowY = contentLines > maxLines ? 'auto' : 'hidden';
  return Math.abs(nextHeight - previousHeight) > 1;
}

function commentPreviewText(comment) {
  const trimmed = String(comment.body || '').trim();
  if (trimmed.length > 0) {
    return trimmed.split('\n')[0];
  }
  return comment.excerpt?.trim() || 'Empty note';
}

function measureCommentZoneHeight(comment, domNode) {
  const minHeight = isCommentCollapsed(comment.id)
    ? 52
    : comment.excerpt
      ? 168
      : 108;
  return Math.max(minHeight, Math.ceil(domNode.scrollHeight + 8));
}

function renderCommentDOM(comment, onDelete, onLayoutChange = () => {}) {
  const container = document.createElement('div');
  container.className = 'view-zone-container';
  const collapsed = isCommentCollapsed(comment.id);
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="min-w-0 text-xs font-semibold text-review-text">${escapeHtml(lineRangeLabel(comment))}</div>
      <div class="flex shrink-0 items-center gap-2">
        <button data-action="toggle-collapse" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text">${collapsed ? 'Expand' : 'Collapse'}</button>
        <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
      </div>
    </div>
    <div data-role="collapsed-preview" class="${collapsed ? 'block' : 'hidden'} truncate rounded-md border border-review-border bg-[#010409] px-3 py-2 text-xs text-review-muted">${escapeHtml(commentPreviewText(comment))}</div>
    <div data-role="comment-editor" class="${collapsed ? 'hidden' : 'block'}">
      ${comment.excerpt ? `<pre class="scrollbar-thin mb-3 max-h-24 overflow-auto rounded-md border border-review-border bg-[#010409] px-3 py-2 text-xs text-review-muted whitespace-pre-wrap">${escapeHtml(comment.excerpt)}</pre>` : ''}
      <textarea rows="2" data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[50px] w-full resize-none rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm leading-5 text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
    </div>
  `;

  const textarea = container.querySelector('textarea');
  const deleteButton = container.querySelector("[data-action='delete']");
  const toggleButton = container.querySelector(
    "[data-action='toggle-collapse']",
  );

  [deleteButton, toggleButton].forEach(element => {
    if (element) wireCommentInput(element);
  });

  if (textarea !== null) {
    textarea.value = comment.body || '';
    wireCommentInput(textarea);
    installTextareaShortcutFallback(textarea);
    autosizeCommentTextarea(textarea);
    textarea.addEventListener('keydown', event => {
      const isPlainArrowNavigation =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      const selectionStart = textarea.selectionStart ?? 0;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const textLength = textarea.value.length;

      if (
        comment.startLine !== null &&
        comment.startLine !== undefined &&
        isPlainArrowNavigation &&
        event.key === 'ArrowUp' &&
        selectionStart === 0 &&
        selectionEnd === 0
      ) {
        event.preventDefault();
        event.stopPropagation();
        collapseComment(comment, {targetLine: (comment.startLine ?? 1) - 1});
        return;
      }

      if (
        comment.startLine !== null &&
        comment.startLine !== undefined &&
        isPlainArrowNavigation &&
        event.key === 'ArrowDown' &&
        selectionStart === textLength &&
        selectionEnd === textLength
      ) {
        event.preventDefault();
        event.stopPropagation();
        collapseComment(comment);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        comment.body = textarea.value;
        if (textarea.value.trim().length > 0) {
          const selectionSnapshot = captureTextareaSelection(textarea);
          showConfirmModal({
            title: 'Delete note?',
            description: `Delete ${lineRangeLabel(comment).toLowerCase()} and its text?`,
            confirmLabel: 'Delete note',
            confirmTone: 'danger',
            onConfirm: () => {
              deleteComment(
                comment,
                comment.startLine !== null && comment.startLine !== undefined
                  ? {focusLine: comment.startLine}
                  : {},
              );
            },
            onCancel: () => {
              requestAnimationFrame(() => {
                focusCommentTextarea(textarea, selectionSnapshot);
              });
            },
          });
          return;
        }
        collapseComment(comment);
        return;
      }

      const isCollapseShortcut =
        (event.metaKey || event.ctrlKey) && event.key === 'Enter';
      if (!isCollapseShortcut) return;
      event.preventDefault();
      event.stopPropagation();
      collapseComment(comment);
    });
    textarea.addEventListener('input', () => {
      comment.body = textarea.value;
      const heightChanged = autosizeCommentTextarea(textarea);
      if (heightChanged) {
        onLayoutChange();
      }
      updateButtons();
    });
  }

  deleteButton?.addEventListener('click', onDelete);
  toggleButton?.addEventListener('click', () => {
    getCommentUi(comment.id).collapsed = !isCommentCollapsed(comment.id);
    renderAll({preserveScroll: true});
  });

  if (!collapsed && textarea !== null && !comment.body) {
    setTimeout(() => textarea.focus(), 50);
  }

  requestAnimationFrame(() => {
    onLayoutChange();
  });

  return container;
}

function syncViewZones() {
  clearViewZones();
  if (!editor || !isActiveResponseReady()) return;
  const draft = activeDraft();
  if (!draft) return;
  const inlineComments = draft.comments.filter(
    comment => comment.startLine !== null && comment.startLine !== undefined,
  );
  inlineComments.forEach(comment => {
    const zoneEntry = {
      id: null,
      zone: null,
    };
    const domNode = renderCommentDOM(
      comment,
      () => {
        deleteComment(comment);
      },
      () => {
        if (!editor || zoneEntry.id === null || zoneEntry.zone === null) return;
        zoneEntry.zone.heightInPx = measureCommentZoneHeight(comment, domNode);
        editor.changeViewZones(accessor => {
          accessor.layoutZone(zoneEntry.id);
        });
      },
    );
    editor.changeViewZones(accessor => {
      zoneEntry.zone = {
        afterLineNumber: comment.endLine || comment.startLine,
        heightInPx: measureCommentZoneHeight(comment, domNode),
        domNode,
      };
      zoneEntry.id = accessor.addZone(zoneEntry.zone);
      activeViewZones.push(zoneEntry);
    });
  });
}

function updateDecorations() {
  if (!editor || !monacoApi) return;
  const draft = activeDraft();
  const inlineComments = draft
    ? draft.comments.filter(
        comment =>
          comment.startLine !== null && comment.startLine !== undefined,
      )
    : [];
  const nextDecorations = inlineComments.map(comment => ({
    range: new monacoApi.Range(
      comment.startLine,
      1,
      comment.endLine || comment.startLine,
      1,
    ),
    options: {
      isWholeLine: true,
      className: 'response-comment-line',
      glyphMarginClassName: 'response-comment-glyph',
    },
  }));
  decorations = editor.deltaDecorations(decorations, nextDecorations);
}

function renderWholeResponseComments() {
  responseCommentsContainer.innerHTML = '';
  const draft = activeDraft();
  if (!draft) {
    responseCommentsContainer.className = 'hidden overflow-hidden px-0 py-0';
    return;
  }

  const comments = draft.comments.filter(
    comment => comment.startLine === null || comment.startLine === undefined,
  );
  if (comments.length === 0) {
    responseCommentsContainer.className = 'hidden overflow-hidden px-0 py-0';
    return;
  }

  responseCommentsContainer.className =
    'space-y-4 border-b border-review-border bg-[#0d1117] px-4 py-4';
  comments.forEach(comment => {
    const dom = renderCommentDOM(comment, () => {
      deleteComment(comment);
    });
    dom.className =
      'rounded-lg border border-review-border bg-review-panel p-4';
    responseCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderText(response) {
  const request = requestState(response.id);
  if (request.error) {
    return `Failed to load response #${response.index}\n\n${request.error}`;
  }
  return `Loading response #${response.index}...`;
}

function activeMountedText() {
  const response = activeResponse();
  if (!response) return '';
  return state.responseContents[response.id] || getPlaceholderText(response);
}

function isActiveResponseReady() {
  const response = activeResponse();
  if (!response) return false;
  const request = requestState(response.id);
  return (
    request.text !== null &&
    request.text !== undefined &&
    request.error === undefined
  );
}

function applyEditorOptions() {
  if (!editor) return;
  editor.updateOptions({
    wordWrap: state.wrapLines ? 'on' : 'off',
  });
}

function layoutEditor() {
  if (!editor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  editor.layout({width, height});
}

function maybeInitializeEditorCursor() {
  if (hasInitializedEditorCursor || !editor || !model) return;
  hasInitializedEditorCursor = true;
  requestAnimationFrame(() => {
    moveEditorCursorToLine(1);
  });
}

function mountResponse(options = {}) {
  if (!editor || !monacoApi) return;
  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll
    ? {top: editor.getScrollTop(), left: editor.getScrollLeft()}
    : null;

  clearViewZones();

  if (model) model.dispose();
  model = monacoApi.editor.createModel(activeMountedText(), 'plaintext');
  editor.setModel(model);
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderWholeResponseComments();
  updateSelectionWidget();

  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreScroll) restoreScrollPosition();
    maybeInitializeEditorCursor();
    if (scrollState) {
      editor.setScrollTop(scrollState.top);
      editor.setScrollLeft(scrollState.left);
    }
    setTimeout(() => {
      layoutEditor();
      if (options.restoreScroll) restoreScrollPosition();
      if (scrollState) {
        editor.setScrollTop(scrollState.top);
        editor.setScrollLeft(scrollState.left);
      }
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll('textarea[data-comment-id]');
  textareas.forEach(textarea => {
    const commentId = textarea.getAttribute('data-comment-id');
    const draft = activeDraft();
    const comment = draft?.comments.find(item => item.id === commentId);
    if (comment) comment.body = textarea.value;
  });
}

function buildSubmitPayload() {
  syncCommentBodiesFromDOM();
  const draft = activeDraft();
  if (!draft || !state.activeResponseId) return null;
  const payload = {
    type: 'submit',
    responseId: state.activeResponseId,
    overallComment: draft.overallComment.trim(),
    comments: draft.comments
      .map(comment => ({...comment, body: comment.body.trim()}))
      .filter(comment => comment.body.length > 0),
  };
  if (payload.overallComment.length === 0 && payload.comments.length === 0)
    return null;
  return payload;
}

function performSubmit() {
  const payload = buildSubmitPayload();
  if (!payload) return false;
  window.glimpse.send(payload);
  window.glimpse.close();
  return true;
}

function renderAll(options = {}) {
  renderSidebar();
  if (editor && monacoApi) {
    mountResponse(options);
    requestAnimationFrame(() => {
      layoutEditor();
      updateSelectionWidget();
      setTimeout(() => {
        layoutEditor();
        updateSelectionWidget();
      }, 50);
    });
  } else {
    renderWholeResponseComments();
  }
}

function clearPendingGutterClick() {
  if (pendingGutterClickTimer === null) return;
  clearTimeout(pendingGutterClickTimer);
  pendingGutterClickTimer = null;
}

function getMouseClickCount(event) {
  return event?.event?.detail ?? event?.event?.browserEvent?.detail ?? 1;
}

function createGlyphHoverActions() {
  editor.onMouseMove(event => {
    if (!isActiveResponseReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (
      target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [
        {
          range: new monacoApi.Range(line, 1, line, 1),
          options: {glyphMarginClassName: 'response-glyph-plus'},
        },
      ]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    clearPendingGutterClick();
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown(event => {
    editor.focus();
    if (!isActiveResponseReady()) return;
    const target = event.target;
    const line = target.position?.lineNumber;
    const clickCount = getMouseClickCount(event);

    if (clickCount >= 2 && line !== null && line !== undefined) {
      clearPendingGutterClick();
      const lineEndColumn =
        model !== null && model !== undefined
          ? model.getLineMaxColumn(line)
          : 1;
      setTimeout(() => {
        editor.setSelection(new monacoApi.Range(line, 1, line, lineEndColumn));
        updateSelectionWidget();
      }, 0);
      return;
    }

    if (
      target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      if (!line) return;

      clearPendingGutterClick();
      pendingGutterClickTimer = setTimeout(() => {
        pendingGutterClickTimer = null;
        const selectionRange = getSelectionLineRange();
        if (
          selectionRange !== null &&
          line >= selectionRange.startLine &&
          line <= selectionRange.endLine
        ) {
          addInlineComment(selectionRange.startLine, selectionRange.endLine);
          return;
        }
        addInlineComment(line, line);
      }, 220);
    }
  });
}

window.__responseReviewReceive = function (message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'debug-log') {
    debugLog(`host ${message.message}`, message.details);
    return;
  }

  if (
    typeof message.requestId === 'string' &&
    pendingHostRequests.has(message.requestId)
  ) {
    const resolve = pendingHostRequests.get(message.requestId);
    resolve(message);
    return;
  }

  if (message.type === 'response-data') {
    state.responseContents[message.responseId] = message.text;
    state.responseUserTexts[message.responseId] = message.precedingUserText;
    delete state.responseErrors[message.responseId];
    delete state.pendingRequestIds[message.responseId];
    renderSidebar();
    if (state.activeResponseId === message.responseId) {
      mountResponse({restoreScroll: true});
    }
    return;
  }

  if (message.type === 'response-error') {
    state.responseErrors[message.responseId] =
      message.message || 'Unknown error';
    delete state.pendingRequestIds[message.responseId];
    renderSidebar();
    if (state.activeResponseId === message.responseId) {
      mountResponse({preserveScroll: false});
    }
  }
};

window.addEventListener('keydown', event => {
  const key = String(event.key || '').toLowerCase();
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 'd') {
    event.preventDefault();
    event.stopPropagation();
    setDebugEnabled(!debugState.enabled);
    debugLog('debug toggled', {enabled: debugState.enabled});
  }
});

window.addEventListener(
  'paste',
  event => {
    debugLog('window paste event', {
      hasClipboardData:
        event.clipboardData !== null && event.clipboardData !== undefined,
      activeTag: document.activeElement?.tagName ?? null,
    });
  },
  true,
);

function setupMonaco() {
  window.require.config({
    paths: {
      vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs',
    },
  });

  window.require(['vs/editor/editor.main'], () => {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme('review-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1117',
        'editor.lineHighlightBackground': '#11161d',
        'editor.selectionBackground': '#264f78',
      },
    });
    monacoApi.editor.setTheme('review-dark');

    editor = monacoApi.editor.create(editorContainerEl, {
      automaticLayout: true,
      readOnly: true,
      minimap: {
        enabled: true,
        renderCharacters: false,
        showSlider: 'always',
        size: 'proportional',
      },
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: 'on',
      bracketPairColorization: {enabled: false},
    });

    createGlyphHoverActions();
    ensureSelectionWidget();
    editor.onDidFocusEditorText(() => {
      debugLog('editor focus', {
        line: editor.getPosition()?.lineNumber ?? null,
      });
    });
    editor.onDidBlurEditorText(() => {
      shouldOpenCommentOnArrowNavigation = false;
      debugLog('editor blur', {
        activeTag: document.activeElement?.tagName ?? null,
      });
    });
    editor.onKeyDown(event => {
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        [monacoApi.KeyCode.UpArrow, monacoApi.KeyCode.DownArrow].includes(
          event.keyCode,
        )
      ) {
        shouldOpenCommentOnArrowNavigation = true;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.keyCode === monacoApi.KeyCode.Enter
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!hasActiveFeedback()) return;
        const selectionSnapshot = captureEditorSelectionSnapshot();
        showConfirmModal({
          title: 'Finalize review?',
          description: 'Finish review and send the current notes?',
          confirmLabel: 'Finish review',
          onConfirm: () => {
            performSubmit();
          },
          onCancel: () => {
            requestAnimationFrame(() => {
              restoreEditorSelectionSnapshot(selectionSnapshot);
            });
          },
        });
        return;
      }
      if (
        event.keyCode !== monacoApi.KeyCode.Enter ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = getActiveCommentTarget();
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      addInlineComment(target.startLine, target.endLine);
    });
    editor.onDidChangeCursorSelection(() => {
      if (normalizeEditorSelectionToWholeLines()) return;
      const active = activeResponse();
      const commentTarget =
        active !== null && isActiveResponseReady()
          ? getActiveCommentTarget()
          : null;
      modeHintEl.textContent = modeHintText(active, commentTarget);
      updateButtons();
      updateSelectionWidget();
      if (shouldOpenCommentOnArrowNavigation) {
        shouldOpenCommentOnArrowNavigation = false;
        maybeOpenCommentForActiveEditorLine();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountResponse();
  });
}

overallCommentButton.addEventListener('click', () => {
  showOverallCommentModal();
});

toggleWrapButton.addEventListener('click', () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    updateSelectionWidget();
    setTimeout(() => {
      layoutEditor();
      updateSelectionWidget();
    }, 50);
  });
});

toggleSidebarButton.addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  updateSidebarLayout();
  requestAnimationFrame(() => {
    layoutEditor();
    updateSelectionWidget();
    setTimeout(() => {
      layoutEditor();
      updateSelectionWidget();
    }, 50);
  });
});

sidebarSearchInputEl.addEventListener('input', () => {
  state.search = sidebarSearchInputEl.value;
  renderSidebar();
});

sidebarSearchInputEl.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    sidebarSearchInputEl.value = '';
    state.search = '';
    renderSidebar();
  }
});

setDebugEnabled(getStoredDebugEnabled());

submitButton.addEventListener('click', () => {
  performSubmit();
});

cancelButton.addEventListener('click', () => {
  window.glimpse.send({type: 'cancel'});
  window.glimpse.close();
});

ensureActiveResponse();
if (state.activeResponseId) ensureResponseLoaded(state.activeResponseId);
renderSidebar();
renderWholeResponseComments();
updateSidebarLayout();
setupMonaco();
