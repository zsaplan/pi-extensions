import {open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument} from 'yaml';
import {Type} from 'typebox';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {
  absent,
  atomicJson,
  digest,
  exactKeys,
  readJson,
  record,
  StoreError,
  TaskStore,
  updateJson,
} from './store.ts';
import {TaskLogFeed, type LogScope} from './task-logs.ts';

import {
  InvestigationProgress,
  progressState,
} from './investigation-progress.ts';

export const INVESTIGATION_VERSION = 4;
type TraceSelection =
  | 'log_trace_id'
  | 'error_service_match'
  | 'site_sample'
  | 'service_followup';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce((v, key) => object(v)[key], value);
const errorCode = (error: unknown) =>
  error instanceof StoreError ? error.code : 'investigation_read_failed';
async function yamlFile(file: string) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new StoreError('configuration_file_too_large');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new StoreError('configuration_file_too_large');
    const document = parseDocument(text, {uniqueKeys: true});
    if (document.errors.length)
      throw new StoreError('invalid_configuration_yaml');
    return {
      data: record(document.toJS({maxAliasCount: 10})),
      sha256: digest(text),
    };
  } finally {
    await handle.close();
  }
}

export async function requireInvestigationCapability(
  store: TaskStore,
  id: string,
  enabled: boolean,
) {
  if (enabled) return;
  try {
    await readJson(
      path.join(store.root, 'intake', 'investigation', `${id}.json`),
    );
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  throw new StoreError('investigation_scope_required');
}

export class TaskInvestigation {
  readonly scope: LogScope;
  private constructor(
    private store: TaskStore,
    private logs: TaskLogFeed,
    private manifest: string,
    private chart: string,
    private values: string,
  ) {
    this.scope = logs.scope;
  }
  static async open(
    store: TaskStore,
    logs: TaskLogFeed,
    manifest: string,
    chartDirectory: string,
  ) {
    const instance = new TaskInvestigation(
      store,
      logs,
      await realpath(manifest),
      await realpath(path.join(chartDirectory, 'Chart.yaml')),
      await realpath(path.join(chartDirectory, 'values.yaml')),
    );
    // Validate identity before any worker or network activity; never return raw manifest values.
    await instance.configuration();
    const binding = {
      version: 1,
      scope: logs.scope,
      manifest: instance.manifest,
      chart: instance.chart,
      values: instance.values,
    };
    await updateJson(
      path.join(
        store.root,
        'intake',
        'investigation',
        `${logs.scope.task_id}.json`,
      ),
      current => {
        store.assertOwner();
        if (
          current !== undefined &&
          JSON.stringify(current) !== JSON.stringify(binding)
        )
          throw new StoreError('investigation_scope_mismatch');
        return current === undefined ? binding : undefined;
      },
    );
    return instance;
  }
  async needsInitialCheck() {
    try {
      return (
        at(
          await readJson(
            path.join(this.store.root, 'runs', `${this.scope.task_id}.json`),
          ),
          'investigation_version',
        ) !== INVESTIGATION_VERSION
      );
    } catch (error) {
      if (absent(error)) return true;
      throw error;
    }
  }
  async needsFollowup() {
    try {
      const journal = record(
        await readJson(
          path.join(this.store.root, 'runs', `${this.scope.task_id}.json`),
        ),
      );
      const progress = progressState(
        this.scope,
        journal.investigation_progress,
      );
      return (
        journal.phase === 'settled' &&
        !progress?.followup_used &&
        progress?.checkpoint?.status === 'follow_up'
      );
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  }
  private async configuration() {
    this.store.assertOwner();
    const manifest = await yamlFile(this.manifest),
      chart = await yamlFile(this.chart),
      defaults = await yamlFile(this.values);
    const doc = manifest.data,
      spec = object(doc.spec),
      application = object(spec.application);
    const isSite = doc.kind === 'Site';
    if (!isSite && doc.kind !== 'HelmRelease')
      throw new StoreError('unsupported_site_manifest');
    const values = object(isSite ? application.values : spec.values);
    const environment = isSite
      ? spec.environment
      : at(values, 'global', 'environment');
    if (
      at(doc, 'metadata', 'name') !== this.scope.site ||
      environment !== this.scope.environment ||
      (isSite && spec.client !== this.scope.site) ||
      (at(values, 'global', 'client') !== undefined &&
        at(values, 'global', 'client') !== this.scope.site)
    )
      throw new StoreError('configuration_site_mismatch');
    const chartName = isSite
      ? at(application, 'chart', 'name')
      : at(spec, 'chart', 'spec', 'chart');
    if (chartName !== undefined && chartName !== 'bundle')
      throw new StoreError('unsupported_site_chart');
    const version = isSite
      ? at(application, 'chart', 'version')
      : at(spec, 'chart', 'spec', 'version');
    if (
      typeof version !== 'string' ||
      chart.data.name !== 'bundle' ||
      chart.data.version !== version
    )
      throw new StoreError('configuration_chart_version_mismatch');
    const extraSources = [spec.valuesFrom, application.valuesFrom].some(
      value => Array.isArray(value) && value.length > 0,
    );
    const setting = (...keys: string[]) => {
      const explicit = at(values, ...keys),
        fallback = at(defaults.data, ...keys);
      const raw = explicit !== undefined ? explicit : fallback;
      return {
        configured: typeof raw === 'boolean' ? raw : null,
        source:
          explicit !== undefined
            ? 'manifest'
            : fallback !== undefined
              ? 'chart_default'
              : 'unspecified',
        effective: !extraSources && typeof raw === 'boolean' ? raw : null,
        key: keys.join('.'),
      };
    };
    const services = [
      'agents',
      'bc-public',
      'briteapps',
      'mcp',
      'briteauth',
      'britecore',
      'local',
    ].map(name => ({name, ...setting(name, 'enabled')}));
    return {
      checked_at: new Date().toISOString(),
      scope: this.scope,
      manifest_kind: doc.kind,
      provenance: {
        manifest_sha256: manifest.sha256,
        bundle_version: version,
        chart_sha256: chart.sha256,
        defaults_sha256: defaults.sha256,
      },
      faro: setting('global', 'faro', 'enabled'),
      services,
      limitations: [
        'Repository configuration only; no proof of deployed resources, frontend execution, successful collection, or user impact.',
        'Boolean settings only; secrets, environment values, customer identifiers and raw manifests are not returned.',
        'Controller-generated values, template-derived behavior and individual workload defaults are not rendered.',
        ...(extraSources
          ? [
              'Additional valuesFrom sources were not resolved; effective settings remain unknown.',
            ]
          : []),
      ],
    };
  }
  beginRun(
    logTraceIds: string[],
    parentSignal: AbortSignal,
    errorServices: string[] = [],
    progress?: InvestigationProgress,
  ) {
    const state = {
      configurationChecked: false,
      tracesChecked: false,
      tools: [] as ToolDefinition[],
    };
    const cache = new Map<string, Promise<unknown>>();
    const tool = (
      name: string,
      description: string,
      read: (signal: AbortSignal) => Promise<unknown>,
    ) =>
      ({
        name,
        label: name,
        description,
        parameters: Type.Object({}, {additionalProperties: false}),
        execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
          exactKeys(record(input), []);
          const combined = AbortSignal.any([
            parentSignal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(20000),
          ]);
          if (combined.aborted) throw new StoreError('investigation_cancelled');
          let pending = cache.get(name);
          if (!pending) {
            pending = (async () => {
              let result: unknown;
              try {
                result = await read(combined);
              } catch (error) {
                result = {
                  status: 'unavailable',
                  checked_at: new Date().toISOString(),
                  error: errorCode(error),
                  limitations: [
                    'This check failed; do not infer disabled instrumentation or healthy traces.',
                  ],
                };
              }
              if (combined.aborted)
                throw new StoreError('investigation_cancelled');
              this.store.assertOwner();
              const traces = object(result).traces;
              const services = Array.isArray(traces)
                ? traces.flatMap(trace => {
                    const errors = object(trace).errors;
                    return Array.isArray(errors)
                      ? errors.map(span => String(object(span).service ?? ''))
                      : [];
                  })
                : [];
              result = {
                ...object(result),
                ...progress?.evidence(name, result, services),
              };
              await atomicJson(
                path.join(
                  this.store.root,
                  'runs',
                  'evidence',
                  this.scope.task_id,
                  `${Date.now()}-${name}.json`,
                ),
                result,
              );
              return result;
            })();
            cache.set(name, pending);
          }
          const result = await pending;
          if (combined.aborted) throw new StoreError('investigation_cancelled');
          if (name === 'read_site_configuration')
            state.configurationChecked = true;
          else state.tracesChecked = true;
          return {
            content: [{type: 'text' as const, text: JSON.stringify(result)}],
            details: {},
          };
        },
      }) satisfies ToolDefinition;
    state.tools.push(
      tool(
        'read_site_configuration',
        'Read selected-site manifest and matching bundle defaults. Returns boolean Faro/service settings, origin, source hashes and limits, not arbitrary files or secrets.',
        () => this.configuration(),
      ),
    );
    state.tools.push(
      tool(
        'inspect_task_traces',
        'Try fixed site-filtered Tempo access and inspect up to three relevant traces. No query, ID, site or time-range override. Return scoped span summaries and failed/empty/partial checks honestly; this is not a site-health test.',
        signal =>
          this.traces(
            progress?.followup ? [] : logTraceIds,
            errorServices,
            signal,
            progress?.followup?.service,
          ),
      ),
    );
    return state;
  }
  private async traces(
    logTraceIds: string[],
    errorServices: string[],
    signal: AbortSignal,
    followupService?: string,
  ) {
    const candidates = new Map<string, TraceSelection>();
    // Prefer direct links, newest first, without allowing duplicate IDs to consume the budget.
    for (const id of logTraceIds
      .filter(id => /^[a-f0-9]{32}$/i.test(id))
      .map(id => id.toLowerCase())
      .reverse())
      candidates.set(id, 'log_trace_id');
    const services = new Set(
      errorServices.filter(service => service && service !== 'unknown'),
    );
    let search: Record<string, unknown>;
    try {
      const found = await this.logs.searchTraces(signal, followupService);
      if (!Array.isArray(found.data.traces))
        throw new StoreError('tempo_invalid_search');
      const metrics = object(found.data.metrics);
      if (
        found.data.error ||
        found.data.errors ||
        found.data.status === 'error'
      )
        throw new StoreError('tempo_partial_search');
      if (found.data.traces.length > 6)
        throw new StoreError('tempo_search_limit_exceeded');
      for (const row of found.data.traces) {
        const id = at(row, 'traceID') ?? at(row, 'traceId');
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id))
          throw new StoreError('tempo_invalid_search');
        const normalized = id.toLowerCase();
        if (!candidates.has(normalized))
          candidates.set(
            normalized,
            followupService
              ? 'service_followup'
              : services.has(String(at(row, 'rootServiceName') ?? ''))
                ? 'error_service_match'
                : 'site_sample',
          );
      }
      // A limit can stop backend jobs early. Keep usable candidates, while disclosing partial coverage.
      const partial =
        Number(metrics.totalJobs) > Number(metrics.completedJobs) ||
        found.data.partial === true ||
        found.data.status === 'partial';
      // Search metadata is not emitted: a fetched trace must pass attribution first.
      search = {
        status: 'queried',
        from: found.from,
        to: found.to,
        query: found.query,
        returned_candidates: found.data.traces.length,
        capped: found.data.traces.length >= 6,
        job_coverage: partial
          ? 'partial'
          : typeof metrics.totalJobs === 'number' &&
              typeof metrics.completedJobs === 'number'
            ? 'reported_complete'
            : 'not_reported',
      };
    } catch (error) {
      search = {status: 'unavailable', error: errorCode(error)};
    }
    const traces: unknown[] = [];
    const priority: Record<TraceSelection, number> = {
      log_trace_id: 0,
      service_followup: 1,
      error_service_match: 1,
      site_sample: 2,
    };
    const selected = [...candidates]
      .sort((a, b) => priority[a[1]] - priority[b[1]])
      .slice(0, 3);
    for (const [id, selection] of selected) {
      if (signal.aborted) throw new StoreError('investigation_cancelled');
      try {
        traces.push({
          ...this.summarizeTrace(await this.logs.readTrace(id, signal), id),
          selection_hint: selection,
        });
      } catch (error) {
        traces.push({
          trace_id: id,
          selection_hint: selection,
          status: 'unavailable',
          error: errorCode(error),
        });
      }
    }
    return {
      checked_at: new Date().toISOString(),
      scope: this.scope,
      followup_service: followupService ?? null,
      search,
      traces,
      candidates_not_inspected: Math.max(0, candidates.size - 3),
      limitations: [
        'At most three traces from a 15-minute site-filtered search and current site-log trace IDs; not a census or an error-rate estimate.',
        'Search only covers known resource client_name/site_name/k8s.namespace.name labels; unlabelled frontend or backend traces can be missed.',
        'Direct log trace IDs are preferred, then search service names matching current error logs, then other samples. Service matching is a selection hint, not proof of a shared request or cause; relevant traces outside the returned candidates can still be missed.',
        'A planned follow-up searches only the previously observed service in the same rolling site window; it does not refetch old log IDs. Same service does not imply the same operation, incident time or request. Historical incident windows and targeted dependency logs remain unavailable.',
        'Only site-attributed resources are summarized. Unattributed spans are withheld; missing spans can hide errors or latency.',
        'Backend trace access does not prove Faro frontend instrumentation or complete frontend-to-backend tracing.',
        'Empty, denied, missing or partial results do not prove health. No raw attributes, headers, SQL, event payloads or customer identifiers are returned.',
      ],
    };
  }
  private summarizeTrace(data: Record<string, unknown>, traceId: string) {
    if (
      data.error ||
      data.errors ||
      data.partial === true ||
      data.status === 'partial' ||
      (Array.isArray(data.warnings) && data.warnings.length)
    )
      throw new StoreError('tempo_partial_trace');
    const batches = data.batches ?? data.resourceSpans;
    if (!Array.isArray(batches) || !batches.length)
      throw new StoreError('tempo_empty_or_invalid_trace');
    const attrs = (raw: unknown) => {
      const result: Record<string, string> = {};
      if (!Array.isArray(raw)) return result;
      for (const item of raw) {
        const key = at(item, 'key'),
          value = object(at(item, 'value'));
        if (typeof key === 'string')
          result[key] = String(
            value.stringValue ?? value.intValue ?? value.boolValue ?? '',
          );
      }
      return result;
    };
    let withheld = 0,
      total = 0;
    const spans: {
      service: string;
      name: string;
      duration_ms: number;
      started_at: string;
      finished_at: string;
      error: boolean;
      http_status: number | null;
    }[] = [];
    for (const batch of batches) {
      const resource = attrs(at(batch, 'resource', 'attributes'));
      const clients = [resource.client_name, resource.site_name].filter(
        Boolean,
      );
      const namespace = resource['k8s.namespace.name'];
      const env =
        resource['deployment.environment.name'] ??
        resource['deployment.environment'] ??
        resource.environment;
      if (
        clients.some(value => value !== this.scope.site) ||
        (namespace?.startsWith('client-') &&
          namespace !== `client-${this.scope.site}`) ||
        (env && env !== this.scope.environment)
      )
        throw new StoreError('tempo_cross_site_trace');
      const attributed =
        clients.includes(this.scope.site) ||
        namespace === `client-${this.scope.site}`;
      const groups =
        at(batch, 'scopeSpans') ?? at(batch, 'instrumentationLibrarySpans');
      if (!Array.isArray(groups)) throw new StoreError('tempo_invalid_trace');
      for (const group of groups) {
        const values = at(group, 'spans');
        if (!Array.isArray(values)) throw new StoreError('tempo_invalid_trace');
        for (const value of values) {
          if (++total > 500) throw new StoreError('tempo_span_limit_exceeded');
          const span = record(value);
          const rawId = String(span.traceId ?? '');
          const returnedId = /^[a-f0-9]{32}$/i.test(rawId)
            ? rawId.toLowerCase()
            : Buffer.from(rawId, 'base64').toString('hex');
          if (returnedId !== traceId)
            throw new StoreError('tempo_trace_id_mismatch');
          if (!attributed) {
            withheld++;
            continue;
          }
          const start = Number(span.startTimeUnixNano),
            end = Number(span.endTimeUnixNano);
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start <= 0 ||
            end < start
          )
            throw new StoreError('tempo_invalid_span_time');
          const attributes = attrs(span.attributes),
            code = at(span, 'status', 'code');
          if (
            [attributes.client_name, attributes.site_name]
              .filter(Boolean)
              .some(value => value !== this.scope.site)
          )
            throw new StoreError('tempo_cross_site_trace');
          const status = Number(
            attributes['http.response.status_code'] ??
              attributes['http.status_code'],
          );
          const clean = (text: string) =>
            this.logs
              .redact(text)
              .replace(/https?:\/\/\S+/gi, '[URL]')
              .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[ID]')
              .slice(0, 120);
          // Operation names may include IDs: expose a conservative route shape, not arbitrary attributes.
          spans.push({
            service: clean(resource['service.name'] ?? 'unknown'),
            name: clean(String(span.name ?? 'unknown')).replace(
              /\/[^\s/]*\d[^\s/]*/g,
              '/[ID]',
            ),
            duration_ms: (end - start) / 1e6,
            started_at: new Date(start / 1e6).toISOString(),
            finished_at: new Date(end / 1e6).toISOString(),
            error: code === 2 || code === 'STATUS_CODE_ERROR',
            http_status: status >= 100 && status <= 599 ? status : null,
          });
        }
      }
    }
    if (!spans.length)
      throw new StoreError('tempo_site_attribution_unverified');
    const errors = spans.filter(
      span => span.error || (span.http_status ?? 0) >= 400,
    );
    return {
      trace_id: traceId,
      status: withheld ? 'partial' : 'inspected',
      scoped_span_count: spans.length,
      withheld_span_count: withheld,
      error_span_count: spans.filter(span => span.error).length,
      http_error_span_count: spans.filter(
        span => (span.http_status ?? 0) >= 400,
      ).length,
      services: [...new Set(spans.map(span => span.service))],
      errors: errors.slice(0, 10),
      error_examples_clipped: errors.length > 10,
      slowest_spans: [...spans]
        .sort((a, b) => b.duration_ms - a.duration_ms)
        .slice(0, 5),
    };
  }
}
