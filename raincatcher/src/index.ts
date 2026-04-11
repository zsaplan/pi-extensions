import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import {
  KB_ROOT_ENV_VAR,
  factHeading,
  getKbRoot as getSharedKbRoot,
  normalizeFact,
  normalizeWhitespace,
  sanitizeSubject,
  sanitizeTopic,
  toFactFilename,
} from "../../rain-core/src/index.ts";

type ToolRecord = {
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
};

type CandidateFact = {
  subject: string;
  topic: string;
  fact: string;
};

type RaincatcherCaptureEntry = {
  capturedAt: number;
  factsWritten: number;
  filesWritten: string[];
};

type RuntimeState = {
  enabled: boolean;
  busy: boolean;
  pendingToolInputs: Record<string, unknown>;
  promptTools: ToolRecord[];
  lastRunAt: number | null;
  lastFilesWritten: string[];
  lastFactsWritten: number;
  sessionFactsWritten: number;
  sessionFilesWritten: string[];
};

const MAX_MESSAGES = 8;
const MAX_TOOL_RECORDS = 8;
const MAX_FACTS = 6;
const MAX_SNIPPET_CHARS = 700;
const MAX_HARVEST_ENTRIES = 120;
const MAX_HARVEST_CHARS = 24_000;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
];

const SECRET_PATTERNS_NO_GLOBAL = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /ghp_[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z\-_]{20,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
];

const SYSTEM_PROMPT = `You are Raincatcher, a durable fact extractor for pi.

Your job is to read the most recent agent interaction and extract only durable, reusable facts worth remembering later.

Good facts:
- user preferences
- project context
- technical stack details
- environment facts
- decisions and constraints
- stable workflow preferences
- durable definitions and troubleshooting knowledge

Bad facts:
- transient status updates
- one-off shell output
- speculative claims
- ephemeral plans that were not decided
- raw secrets, credentials, tokens, passwords, or private keys

Each fact must include:
- subject: the stable system, component, repo, service, or product name
- topic: the stable knowledge category
- fact: one reusable sentence

Use uppercase identifiers with underscores for subject and topic.
Convert spaces and hyphens to underscores.

Good subject examples:
- BC_SITES
- BRITEAUTH
- BRITECORE_WEBAPP
- PI

Good topic examples:
- GITOPS
- DEFINITION
- TROUBLESHOOTING
- DEPLOYMENT
- CONFIGURATION
- WORKFLOW
- USER_PREFERENCES

Return JSON only. No markdown. No code fences.
Return an array of objects like:
[{"subject":"BC_SITES","topic":"GITOPS","fact":"Flux monitors the platform-sites repository for deployment manifest changes."}]

Rules:
- return at most 6 facts
- each fact must be a single sentence
- each fact must stand on its own
- be conservative; if unsure, leave it out
- never include secret values or credential-looking strings`;

function now(): number {
  return Date.now();
}

function getKbRoot(): string {
  return getSharedKbRoot(getAgentDir());
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function redactSecrets(text: string): string {
  let next = text;
  for (const pattern of SECRET_PATTERNS) next = next.replace(pattern, "[REDACTED]");
  next = next.replace(
    /\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z_]*)\b\s*[:=]\s*([^\s,;]+)/gi,
    "$1=[REDACTED]",
  );
  return next;
}

function looksSecretish(text: string): boolean {
  return SECRET_PATTERNS_NO_GLOBAL.some((pattern) => pattern.test(text))
    || /\b(?:token|secret|password|passwd|api[_ -]?key|private key)\b\s*[:=]\s*\S+/i.test(text);
}

function extractTextParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && "type" in part)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function snippet(value: unknown, max = MAX_SNIPPET_CHARS): string {
  return truncate(redactSecrets(normalizeWhitespace(stringifyValue(value))), max);
}

function extractMessageText(message: any): string {
  const direct = typeof message?.content === "string"
    ? message.content
    : extractTextParts(message?.content);
  return redactSecrets(direct).trim();
}

function getRoleLabel(message: any): string {
  const role = String(message?.role ?? "message");
  if (role === "toolResult") return "tool_result";
  return role;
}

function shouldKeepFact(fact: string): boolean {
  const cleaned = normalizeWhitespace(fact);
  if (cleaned.length < 16 || cleaned.length > 280) return false;
  if (looksSecretish(cleaned)) return false;
  return true;
}

function parseFacts(raw: string): CandidateFact[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  const jsonText = arrayMatch ? arrayMatch[0] : cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const unique = new Set<string>();
  const facts: CandidateFact[] = [];
  for (const item of parsed) {
    let rawSubject = typeof item?.subject === "string" ? item.subject : "";
    let rawTopic = typeof item?.topic === "string" ? item.topic : "";

    if (!rawSubject && rawTopic.includes("__")) {
      const [splitSubject = "", splitTopic = ""] = rawTopic.split(/__+/, 2);
      rawSubject = splitSubject;
      rawTopic = splitTopic;
    }

    const subject = sanitizeSubject(rawSubject);
    const topic = sanitizeTopic(rawTopic);
    const fact = redactSecrets(typeof item?.fact === "string" ? item.fact : "").trim();
    if (!fact || !shouldKeepFact(fact)) continue;
    const key = `${toFactFilename(subject, topic)}::${normalizeFact(fact)}`;
    if (unique.has(key)) continue;
    unique.add(key);
    facts.push({ subject, topic, fact: normalizeWhitespace(fact) });
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function buildExtractionPrompt(messages: any[], tools: ToolRecord[]): string {
  const renderedMessages = messages
    .slice(-MAX_MESSAGES)
    .map((message) => {
      const text = extractMessageText(message);
      if (!text) return "";
      return `${getRoleLabel(message)}: ${truncate(text, 1800)}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const renderedTools = tools
    .slice(-MAX_TOOL_RECORDS)
    .map((tool) => {
      const label = tool.isError ? `${tool.toolName} (error)` : tool.toolName;
      return [
        `tool: ${label}`,
        `args: ${snippet(tool.args) || "{}"}`,
        `result: ${snippet(tool.result) || ""}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "Extract durable facts from this recent interaction.",
    "Only keep facts that are likely to matter later.",
    "Skip speculative, temporary, or secret-looking information.",
    "",
    "Recent messages:",
    renderedMessages || "(none)",
    "",
    "Observed tool activity:",
    renderedTools || "(none)",
  ].join("\n");
}

function renderBranchEntry(entry: any): string {
  if (entry?.type === "message") {
    const message = entry.message;
    if (message?.role === "bashExecution") {
      const command = typeof message.command === "string" ? truncate(redactSecrets(message.command), 800) : "";
      const output = typeof message.output === "string" ? truncate(redactSecrets(message.output), 1000) : "";
      return [command ? `bash command: ${command}` : "", output ? `bash output: ${output}` : ""]
        .filter(Boolean)
        .join("\n");
    }
    const text = extractMessageText(message);
    if (!text) return "";
    return `${getRoleLabel(message)}: ${truncate(text, 1800)}`;
  }

  if (entry?.type === "compaction" && typeof entry.summary === "string") {
    return `compaction_summary: ${truncate(redactSecrets(entry.summary), 1800)}`;
  }

  if (entry?.type === "branch_summary" && typeof entry.summary === "string") {
    return `branch_summary: ${truncate(redactSecrets(entry.summary), 1800)}`;
  }

  return "";
}

function buildHarvestPrompt(branchEntries: any[]): string {
  const rendered = branchEntries
    .map((entry) => renderBranchEntry(entry))
    .filter(Boolean)
    .slice(-MAX_HARVEST_ENTRIES)
    .join("\n\n");

  return truncate([
    "Extract durable facts from this session branch.",
    "Only keep facts that are likely to matter later across future work.",
    "Skip speculative, temporary, or secret-looking information.",
    "",
    "Session branch entries:",
    rendered || "(none)",
  ].join("\n"), MAX_HARVEST_CHARS);
}

async function resolveModel(ctx: any): Promise<{ model: any; apiKey?: string; headers?: Record<string, string> } | null> {
  if (!ctx.model) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) return null;
  return {
    model: ctx.model,
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}

async function appendFactsToDisk(facts: CandidateFact[]): Promise<{ filesWritten: string[]; factsWritten: number }> {
  if (facts.length === 0) return { filesWritten: [], factsWritten: 0 };

  const kbRoot = getKbRoot();
  const factsByFile = new Map<string, CandidateFact[]>();
  for (const fact of facts) {
    const filePath = join(kbRoot, toFactFilename(fact.subject, fact.topic));
    const list = factsByFile.get(filePath) ?? [];
    list.push(fact);
    factsByFile.set(filePath, list);
  }

  const filesWritten: string[] = [];
  let factsWritten = 0;

  for (const [filePath, fileFacts] of factsByFile.entries()) {
    const result = await withFileMutationQueue(filePath, async () => {
      await ensureParent(filePath);
      const existing = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
      const existingFacts = new Set(
        existing
          .split(/\r?\n/)
          .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1] ?? "")
          .filter(Boolean)
          .map((line) => normalizeFact(line)),
      );

      const newFacts = fileFacts
        .map((entry) => entry.fact)
        .filter((fact) => !existingFacts.has(normalizeFact(fact)));

      if (newFacts.length === 0) return { wrote: false, count: 0 };

      let next = existing;
      if (!next.trim()) {
        next = `# ${factHeading(fileFacts[0]!.subject, fileFacts[0]!.topic)}\n\n`;
      }
      if (!next.endsWith("\n")) next += "\n";
      if (!next.endsWith("\n\n")) next += "\n";
      next += `${newFacts.map((fact) => `- ${fact}`).join("\n")}\n`;

      await writeFile(filePath, next, "utf8");
      return { wrote: true, count: newFacts.length };
    });

    if (result.wrote) {
      filesWritten.push(filePath);
      factsWritten += result.count;
    }
  }

  return { filesWritten, factsWritten };
}

export default function raincatcher(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    enabled: true,
    busy: false,
    pendingToolInputs: {},
    promptTools: [],
    lastRunAt: null,
    lastFilesWritten: [],
    lastFactsWritten: 0,
    sessionFactsWritten: 0,
    sessionFilesWritten: [],
  };

  function resetPromptState(): void {
    state.pendingToolInputs = {};
    state.promptTools = [];
  }

  function addSessionFiles(files: string[]): void {
    state.sessionFilesWritten = [...new Set([...state.sessionFilesWritten, ...files])];
  }

  function restoreSessionState(ctx: any): void {
    state.lastRunAt = null;
    state.lastFilesWritten = [];
    state.lastFactsWritten = 0;
    state.sessionFactsWritten = 0;
    state.sessionFilesWritten = [];

    const branchEntries = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const entry of branchEntries) {
      if (entry?.type !== "custom" || entry?.customType !== "raincatcher-capture") continue;
      const data = entry.data as RaincatcherCaptureEntry | undefined;
      if (!data) continue;
      state.sessionFactsWritten += typeof data.factsWritten === "number" ? data.factsWritten : 0;
      addSessionFiles(Array.isArray(data.filesWritten) ? data.filesWritten : []);
      state.lastRunAt = typeof data.capturedAt === "number" ? data.capturedAt : state.lastRunAt;
      state.lastFactsWritten = typeof data.factsWritten === "number" ? data.factsWritten : state.lastFactsWritten;
      state.lastFilesWritten = Array.isArray(data.filesWritten) ? data.filesWritten : state.lastFilesWritten;
    }
  }

  function syncStatus(ctx: any): void {
    if (!ctx?.hasUI) return;
    const theme = ctx.ui.theme;
    if (!state.enabled) {
      ctx.ui.setStatus("raincatcher", theme.fg("dim", "☔ off"));
      return;
    }
    const icon = state.busy ? theme.fg("accent", "☔") : theme.fg("success", "☔");
    const counts = theme.fg("dim", ` ${state.sessionFactsWritten} facts ${state.sessionFilesWritten.length} files`);
    const delta = state.lastFactsWritten > 0 ? theme.fg("dim", ` (+${state.lastFactsWritten})`) : "";
    const suffix = state.busy ? theme.fg("dim", " catching") : "";
    ctx.ui.setStatus("raincatcher", `${icon}${counts}${delta}${suffix}`);
  }

  function emitCaptureFiles(writeResult: { filesWritten: string[]; factsWritten: number }): void {
    if (writeResult.filesWritten.length === 0) return;
    pi.events.emit("raincatcher:files-written", {
      kbRoot: getKbRoot(),
      filesWritten: writeResult.filesWritten,
      factsWritten: writeResult.factsWritten,
    });
  }

  function recordCapture(piApi: ExtensionAPI, capturedAt: number, writeResult: { filesWritten: string[]; factsWritten: number }): void {
    state.lastRunAt = capturedAt;
    state.lastFilesWritten = writeResult.filesWritten;
    state.lastFactsWritten = writeResult.factsWritten;
    state.sessionFactsWritten += writeResult.factsWritten;
    addSessionFiles(writeResult.filesWritten);
    if (writeResult.factsWritten > 0) {
      piApi.appendEntry<RaincatcherCaptureEntry>("raincatcher-capture", {
        capturedAt,
        factsWritten: writeResult.factsWritten,
        filesWritten: writeResult.filesWritten,
      });
    }
    emitCaptureFiles(writeResult);
  }

  function notifyCaptureSummary(ctx: any, writeResult: { filesWritten: string[]; factsWritten: number }): void {
    if (!ctx?.hasUI) return;
    ctx.ui.notify(
      `Raincatcher extracted ${writeResult.factsWritten} facts and edited ${writeResult.filesWritten.length} KB files`,
      "info",
    );
  }

  pi.on("session_start", async (_event, ctx: any) => {
    await ensureDir(getKbRoot());
    state.busy = false;
    resetPromptState();
    restoreSessionState(ctx);
    syncStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx: any) => {
    state.busy = false;
    resetPromptState();
    restoreSessionState(ctx);
    syncStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx: any) => {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("raincatcher", undefined);
  });

  pi.on("agent_start", async (_event, ctx: any) => {
    resetPromptState();
    syncStatus(ctx);
  });

  pi.on("tool_call", async (event: any) => {
    state.pendingToolInputs[String(event.toolCallId)] = event.input ?? event.args ?? {};
    return undefined;
  });

  pi.on("tool_execution_end", async (event: any) => {
    const toolCallId = String(event.toolCallId);
    state.promptTools.push({
      toolName: String(event.toolName),
      args: state.pendingToolInputs[toolCallId] ?? event.input ?? event.args ?? {},
      result: event.result,
      isError: Boolean(event.isError),
    });
    delete state.pendingToolInputs[toolCallId];
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    if (!state.enabled || state.busy) {
      syncStatus(ctx);
      return;
    }

    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const promptTextSize = messages
      .map((message) => extractMessageText(message).length)
      .reduce((sum, count) => sum + count, 0);

    if (messages.length === 0 && state.promptTools.length === 0) {
      syncStatus(ctx);
      return;
    }
    if (promptTextSize < 24 && state.promptTools.length === 0) {
      syncStatus(ctx);
      return;
    }

    const model = await resolveModel(ctx);
    if (!model) {
      syncStatus(ctx);
      return;
    }

    state.busy = true;
    syncStatus(ctx);
    try {
      const response = await complete(
        model.model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [{ type: "text", text: buildExtractionPrompt(messages, state.promptTools) }],
            timestamp: Date.now(),
          }],
        },
        {
          apiKey: model.apiKey,
          headers: model.headers,
          signal: ctx.signal,
        },
      );

      const rawText = response.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n");

      const facts = parseFacts(rawText);
      const writeResult = await appendFactsToDisk(facts);
      recordCapture(pi, now(), writeResult);
      notifyCaptureSummary(ctx, writeResult);
    } catch {
      // Stay quiet for now; this extension should not interrupt the main agent.
    } finally {
      state.busy = false;
      resetPromptState();
      syncStatus(ctx);
    }
  });

  pi.registerCommand("raincatcher", {
    description: "Show or control Raincatcher",
    handler: async (args, ctx) => {
      const subcommand = (args || "").trim().toLowerCase();

      if (subcommand === "harvest") {
        if (state.busy) {
          ctx.ui.notify("Raincatcher is already catching", "warning");
          return;
        }

        const model = await resolveModel(ctx);
        if (!model) {
          ctx.ui.notify("Raincatcher harvest needs an active model with auth", "warning");
          return;
        }

        state.busy = true;
        syncStatus(ctx);
        try {
          const branchEntries = ctx.sessionManager.getBranch();
          const response = await complete(
            model.model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [{
                role: "user",
                content: [{ type: "text", text: buildHarvestPrompt(branchEntries) }],
                timestamp: Date.now(),
              }],
            },
            {
              apiKey: model.apiKey,
              headers: model.headers,
              signal: ctx.signal,
            },
          );

          const rawText = response.content
            .filter((part: any) => part?.type === "text")
            .map((part: any) => part.text)
            .join("\n");

          const facts = parseFacts(rawText);
          const writeResult = await appendFactsToDisk(facts);
          recordCapture(pi, now(), writeResult);
          ctx.ui.notify(
            writeResult.factsWritten > 0
              ? `Raincatcher harvested ${writeResult.factsWritten} facts into ${writeResult.filesWritten.length} files`
              : "Raincatcher found no new facts to write",
            "info",
          );
        } catch {
          ctx.ui.notify("Raincatcher harvest failed", "warning");
        } finally {
          state.busy = false;
          syncStatus(ctx);
        }
        return;
      }

      if (subcommand === "off") {
        state.enabled = false;
        syncStatus(ctx);
        ctx.ui.notify("Raincatcher off", "info");
        return;
      }

      if (subcommand === "on") {
        state.enabled = true;
        syncStatus(ctx);
        ctx.ui.notify("Raincatcher on", "info");
        return;
      }

      const lastRun = state.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : "never";
      const files = state.lastFilesWritten.length > 0
        ? state.lastFilesWritten.map((filePath) => `- ${filePath}`).join("\n")
        : "- none yet";

      ctx.ui.notify(
        [
          `Raincatcher: ${state.enabled ? "on" : "off"}`,
          `KB root: ${getKbRoot()}`,
          `Session file: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`,
          `Uses active model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
          `Last run: ${lastRun}`,
          `KB root override env: ${KB_ROOT_ENV_VAR}`,
          `Session facts written: ${state.sessionFactsWritten}`,
          `Session files written: ${state.sessionFilesWritten.length}`,
          `Last facts written: ${state.lastFactsWritten}`,
          "Last files written:",
          files,
        ].join("\n"),
        "info",
      );
    },
  });
}
