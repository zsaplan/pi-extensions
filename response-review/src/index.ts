import {spawn} from 'node:child_process';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import {Key, matchesKey, truncateToWidth} from '@mariozechner/pi-tui';
import {open, type GlimpseWindow} from 'glimpseui';
import {composeResponseReviewPrompt} from './prompt.js';
import {loadResponseReviewSession} from './session.js';
import type {
  ResponseReviewCancelPayload,
  ResponseReviewClipboardReadPayload,
  ResponseReviewClipboardWritePayload,
  ResponseReviewEntryData,
  ResponseReviewHostMessage,
  ResponseReviewRequestPayload,
  ResponseReviewSubmitPayload,
  ResponseReviewWindowData,
  ResponseReviewWindowMessage,
} from './types.js';
import {buildResponseReviewHtml} from './ui.js';

function isSubmitPayload(
  value: ResponseReviewWindowMessage,
): value is ResponseReviewSubmitPayload {
  return value.type === 'submit';
}

function isCancelPayload(
  value: ResponseReviewWindowMessage,
): value is ResponseReviewCancelPayload {
  return value.type === 'cancel';
}

function isRequestPayload(
  value: ResponseReviewWindowMessage,
): value is ResponseReviewRequestPayload {
  return value.type === 'request-response';
}

function isClipboardWritePayload(
  value: ResponseReviewWindowMessage,
): value is ResponseReviewClipboardWritePayload {
  return value.type === 'clipboard-write';
}

function isClipboardReadPayload(
  value: ResponseReviewWindowMessage,
): value is ResponseReviewClipboardReadPayload {
  return value.type === 'clipboard-read';
}

type WaitingEditorResult = 'escape' | 'window-settled';

async function runClipboardCommand(
  command: string,
  args: string[],
  options?: {input?: string},
): Promise<{stdout: string; stderr: string; code: number | null}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'pipe'});
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({stdout, stderr, code});
    });

    if (options?.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function writeSystemClipboard(text: string): Promise<void> {
  if (process.platform === 'darwin') {
    const result = await runClipboardCommand('pbcopy', [], {input: text});
    if (result.code === 0) return;
    throw new Error(result.stderr.trim() || 'pbcopy failed');
  }

  if (process.platform === 'linux') {
    const wlCopy = await runClipboardCommand(
      'bash',
      [
        '-lc',
        'command -v wl-copy >/dev/null 2>&1 && wl-copy || command -v xclip >/dev/null 2>&1 && xclip -selection clipboard || command -v xsel >/dev/null 2>&1 && xsel --clipboard --input || exit 127',
      ],
      {input: text},
    );
    if (wlCopy.code === 0) return;
    throw new Error(wlCopy.stderr.trim() || 'No clipboard writer available');
  }

  if (process.platform === 'win32') {
    const result = await runClipboardCommand(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
      {input: text},
    );
    if (result.code === 0) return;
    throw new Error(result.stderr.trim() || 'Set-Clipboard failed');
  }

  throw new Error(`Clipboard write is unsupported on ${process.platform}`);
}

async function readSystemClipboard(): Promise<string> {
  if (process.platform === 'darwin') {
    const result = await runClipboardCommand('pbpaste', []);
    if (result.code === 0) return result.stdout;
    throw new Error(result.stderr.trim() || 'pbpaste failed');
  }

  if (process.platform === 'linux') {
    const result = await runClipboardCommand('bash', [
      '-lc',
      'command -v wl-paste >/dev/null 2>&1 && wl-paste -n || command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -o || command -v xsel >/dev/null 2>&1 && xsel --clipboard --output || exit 127',
    ]);
    if (result.code === 0) return result.stdout;
    throw new Error(result.stderr.trim() || 'No clipboard reader available');
  }

  if (process.platform === 'win32') {
    const result = await runClipboardCommand('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Clipboard -Raw',
    ]);
    if (result.code === 0) return result.stdout;
    throw new Error(result.stderr.trim() || 'Get-Clipboard failed');
  }

  throw new Error(`Clipboard read is unsupported on ${process.platform}`);
}

function escapeForInlineScript(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow === null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {
      // Ignore close errors from already-closed windows.
    }
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn !== null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>(
      (_tui, theme, _kb, done) => {
        doneFn = done;
        if (pendingResult !== null) {
          const result = pendingResult;
          pendingResult = null;
          queueMicrotask(() => done(result));
        }

        return {
          render(width: number): string[] {
            const innerWidth = Math.max(24, width - 2);
            const borderTop = theme.fg('border', `╭${'─'.repeat(innerWidth)}╮`);
            const borderBottom = theme.fg(
              'border',
              `╰${'─'.repeat(innerWidth)}╯`,
            );
            const lines = [
              theme.fg('accent', theme.bold('Waiting for response review')),
              'The native response review window is open.',
              'Press Escape to cancel and close the review window.',
            ];
            return [
              borderTop,
              ...lines.map(
                line =>
                  `${theme.fg('border', '│')}${truncateToWidth(line, innerWidth, '...', true).padEnd(innerWidth, ' ')}${theme.fg('border', '│')}`,
              ),
              borderBottom,
            ];
          },
          handleInput(data: string): void {
            if (matchesKey(data, Key.escape)) {
              finish('escape');
            }
          },
          invalidate(): void {},
        };
      },
    );

    const dismiss = (): void => {
      finish('window-settled');
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewResponses(
    rawArgs: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (activeWindow !== null) {
      ctx.ui.notify('A response review window is already open.', 'warning');
      return;
    }

    const loadedSession = await loadResponseReviewSession(rawArgs, ctx);
    if (loadedSession.responses.length === 0) {
      ctx.ui.notify(
        'No assistant responses with visible text were found.',
        'info',
      );
      return;
    }

    const responseMap = new Map<string, ResponseReviewEntryData>(
      loadedSession.responses.map(response => [response.id, response]),
    );
    const windowData: ResponseReviewWindowData = {
      session: loadedSession.session,
      responses: loadedSession.responses.map(response => ({
        id: response.id,
        index: response.index,
        timestamp: response.timestamp,
        provider: response.provider,
        model: response.model,
        preview: response.preview,
        precedingUserPreview: response.precedingUserPreview,
        lineCount: response.lineCount,
        charCount: response.charCount,
      })),
    };

    const html = buildResponseReviewHtml(windowData);
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: 'pi response review',
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);

    const sendWindowMessage = (message: ResponseReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__responseReviewReceive(${payload});`);
    };

    const sendHostDebug = (
      message: string,
      details?: Record<string, unknown>,
    ): void => {
      sendWindowMessage({
        type: 'debug-log',
        source: 'host',
        message,
        details,
      });
    };

    ctx.ui.notify('Opened native response review window.', 'info');

    try {
      const terminalMessagePromise = new Promise<
        ResponseReviewSubmitPayload | ResponseReviewCancelPayload | null
      >((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener('message', onMessage);
          window.removeListener('closed', onClosed);
          window.removeListener('error', onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (
          value:
            | ResponseReviewSubmitPayload
            | ResponseReviewCancelPayload
            | null,
        ): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const handleRequest = async (
          message: ResponseReviewRequestPayload,
        ): Promise<void> => {
          const response = responseMap.get(message.responseId);
          if (response === undefined) {
            sendWindowMessage({
              type: 'response-error',
              requestId: message.requestId,
              responseId: message.responseId,
              message: 'Unknown response requested.',
            });
            return;
          }

          sendWindowMessage({
            type: 'response-data',
            requestId: message.requestId,
            responseId: message.responseId,
            text: response.text,
            precedingUserText: response.precedingUserText,
          });
        };

        const handleClipboardWrite = async (
          message: ResponseReviewClipboardWritePayload,
        ): Promise<void> => {
          sendHostDebug('clipboard-write received', {
            requestId: message.requestId,
            textLength: message.text.length,
          });
          try {
            await writeSystemClipboard(message.text);
            sendHostDebug('clipboard-write success', {
              requestId: message.requestId,
            });
            sendWindowMessage({
              type: 'clipboard-write-result',
              requestId: message.requestId,
              ok: true,
            });
          } catch (error) {
            const messageText =
              error instanceof Error ? error.message : String(error);
            sendHostDebug('clipboard-write failure', {
              requestId: message.requestId,
              message: messageText,
            });
            sendWindowMessage({
              type: 'clipboard-write-result',
              requestId: message.requestId,
              ok: false,
              message: messageText,
            });
          }
        };

        const handleClipboardRead = async (
          message: ResponseReviewClipboardReadPayload,
        ): Promise<void> => {
          sendHostDebug('clipboard-read received', {
            requestId: message.requestId,
          });
          try {
            const text = await readSystemClipboard();
            sendHostDebug('clipboard-read success', {
              requestId: message.requestId,
              textLength: text.length,
            });
            sendWindowMessage({
              type: 'clipboard-read-result',
              requestId: message.requestId,
              ok: true,
              text,
            });
          } catch (error) {
            const messageText =
              error instanceof Error ? error.message : String(error);
            sendHostDebug('clipboard-read failure', {
              requestId: message.requestId,
              message: messageText,
            });
            sendWindowMessage({
              type: 'clipboard-read-result',
              requestId: message.requestId,
              ok: false,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ResponseReviewWindowMessage;
          if (isRequestPayload(message)) {
            void handleRequest(message);
            return;
          }
          if (isClipboardWritePayload(message)) {
            void handleClipboardWrite(message);
            return;
          }
          if (isClipboardReadPayload(message)) {
            void handleClipboardRead(message);
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on('message', onMessage);
        window.on('closed', onClosed);
        window.on('error', onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then(message => ({
          type: 'window' as const,
          message,
        })),
        waitingUI.promise.then(reason => ({type: 'ui' as const, reason})),
      ]);

      if (result.type === 'ui' && result.reason === 'escape') {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify('Response review cancelled.', 'info');
        return;
      }

      const message =
        result.type === 'window'
          ? result.message
          : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message === null || message.type === 'cancel') {
        ctx.ui.notify('Response review cancelled.', 'info');
        return;
      }

      const response = responseMap.get(message.responseId);
      if (response === undefined) {
        ctx.ui.notify(
          'Response review failed: selected response was not found.',
          'error',
        );
        return;
      }

      const prompt = composeResponseReviewPrompt(response, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify(
        'Inserted response review feedback into the editor.',
        'info',
      );
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Response review failed: ${message}`, 'error');
    }
  }

  pi.registerCommand('response-review', {
    description:
      'Open a native review window for assistant responses in the current session or a retroactive session',
    handler: async (args, ctx) => {
      await reviewResponses(args ?? '', ctx);
    },
  });

  pi.on('session_shutdown', async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
