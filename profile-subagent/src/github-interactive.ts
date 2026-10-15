import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {getAgentDir, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerGithubResearch} from './github-research.ts';

const execFileAsync = promisify(execFile);

async function githubToken(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return token;
  try {
    const result = await execFileAsync(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      {signal, timeout: 5000, maxBuffer: 8192, encoding: 'utf8'},
    );
    signal.throwIfAborted();
    return result.stdout.trim();
  } catch {
    throw new Error(
      'GitHub credential unavailable; check gh auth or GH_TOKEN.',
    );
  }
}

export default function githubInteractive(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  registerGithubResearch(pi, {
    token: githubToken,
    standardPilot: {
      artifactRoot: join(agentDir, 'profile-subagent-runs'),
      authPath: join(agentDir, 'auth.json'),
    },
    getBinding(ctx, callId) {
      if (ctx.mode !== 'tui') return undefined;
      const sessionId = ctx.sessionManager.getSessionId();
      const assignment = createHash('sha256')
        .update(`${sessionId}\0${callId}`)
        .digest('hex');
      return {
        taskId: `interactive-${assignment}`,
        sessionId,
        threadKey: `interactive-${sessionId}`,
        reservationId: assignment,
        deadlineAt: Date.now() + 90000,
      };
    },
  });
}
