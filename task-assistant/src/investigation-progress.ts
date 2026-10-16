import {Type} from 'typebox';
import {digest, exactKeys, record, StoreError, string} from './store.ts';
import type {LogScope} from './task-logs.ts';

export const checkpointSchema = Type.Object(
  {
    question: Type.String({maxLength: 500}),
    lead: Type.String({maxLength: 1000}),
    result: Type.String({maxLength: 1500}),
    status: Type.Union(
      ['follow_up', 'blocked', 'answered', 'monitoring'].map(value =>
        Type.Literal(value),
      ),
    ),
    evidence_refs: Type.Array(Type.String(), {minItems: 1, maxItems: 8}),
    next_check: Type.Union([
      Type.Null(),
      Type.Object(
        {
          service: Type.String({maxLength: 100}),
          purpose: Type.String({maxLength: 500}),
        },
        {additionalProperties: false},
      ),
    ]),
  },
  {additionalProperties: false},
);

interface Reference {
  ref: string;
  tool: string;
  checked_at: string;
}
export interface InvestigationCheckpoint {
  question: string;
  lead: string;
  result: string;
  status: 'follow_up' | 'blocked' | 'answered' | 'monitoring';
  evidence_refs: string[];
  next_check: {service: string; purpose: string; basis_ref: string} | null;
  references: Reference[];
  recorded_at: string;
}
export interface InvestigationState {
  schema_version: 1;
  scope: LogScope;
  followup_used: boolean;
  checkpoint?: InvestigationCheckpoint;
}
const serviceName = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && value !== 'unknown';

// Journal content is context, never a grant for another site, arbitrary query or tool.
export function progressState(
  scope: LogScope,
  value: unknown,
): InvestigationState | undefined {
  if (value === undefined) return;
  const saved = record(value);
  if (
    saved.schema_version !== 1 ||
    JSON.stringify(saved.scope) !== JSON.stringify(scope) ||
    typeof saved.followup_used !== 'boolean'
  )
    throw new StoreError('investigation_progress_scope_mismatch');
  if (saved.checkpoint !== undefined) {
    const cp = record(saved.checkpoint);
    if (
      !['follow_up', 'blocked', 'answered', 'monitoring'].includes(
        String(cp.status),
      ) ||
      !Array.isArray(cp.references) ||
      cp.references.length > 8 ||
      !Array.isArray(cp.evidence_refs) ||
      cp.evidence_refs.length > 8
    )
      throw new StoreError('invalid_investigation_checkpoint');
    if ((cp.status === 'follow_up') !== (cp.next_check !== null))
      throw new StoreError('invalid_investigation_checkpoint');
    if (cp.next_check !== null) {
      const next = record(cp.next_check);
      if (
        typeof next.service !== 'string' ||
        !serviceName(next.service) ||
        !cp.evidence_refs.includes(next.basis_ref) ||
        !cp.references.some(ref => record(ref).ref === next.basis_ref)
      )
        throw new StoreError('invalid_followup_basis');
    }
  }
  return saved as unknown as InvestigationState;
}

export class InvestigationProgress {
  readonly previous?: InvestigationCheckpoint;
  readonly followup?: NonNullable<InvestigationCheckpoint['next_check']>;
  private used: boolean;
  private references = new Map<string, Reference>();
  private services = new Map<string, Set<string>>();
  constructor(
    readonly scope: LogScope,
    saved: unknown,
    ownerUpdate: boolean,
  ) {
    const state = progressState(scope, saved);
    this.previous = state?.checkpoint;
    this.used = ownerUpdate ? false : (state?.followup_used ?? false);
    if (!ownerUpdate && !this.used && this.previous?.status === 'follow_up')
      this.followup = this.previous.next_check!;
    for (const ref of this.previous?.references ?? [])
      this.references.set(ref.ref, ref);
    if (this.previous?.next_check)
      this.services.set(
        this.previous.next_check.service,
        new Set([this.previous.next_check.basis_ref]),
      );
  }
  // Only scoped adapters register evidence; the model can cite, not invent, these references.
  evidence(tool: string, value: unknown, services: string[] = []) {
    const ref = `evidence:${digest(JSON.stringify({scope: this.scope, tool, value})).slice(0, 32)}`;
    this.references.set(ref, {ref, tool, checked_at: new Date().toISOString()});
    for (const service of services.filter(serviceName)) {
      const sources = this.services.get(service) ?? new Set<string>();
      sources.add(ref);
      this.services.set(service, sources);
    }
    return {
      evidence_ref: ref,
      followup_choices: [...this.services]
        .slice(0, 20)
        .map(([service, refs]) => ({service, evidence_refs: [...refs]})),
    };
  }
  get canSchedule() {
    return !this.used && !this.followup;
  }
  // Carry the last settled checkpoint into the running journal before model/tool work.
  startState(): InvestigationState {
    return {
      schema_version: 1,
      scope: this.scope,
      followup_used: this.used,
      ...(this.previous ? {checkpoint: this.previous} : {}),
    };
  }
  checkpoint(value: unknown): InvestigationCheckpoint {
    const input = record(value);
    exactKeys(input, [
      'question',
      'lead',
      'result',
      'status',
      'evidence_refs',
      'next_check',
    ]);
    const status = String(input.status);
    if (!['follow_up', 'blocked', 'answered', 'monitoring'].includes(status))
      throw new StoreError('invalid_checkpoint_status');
    if (
      !Array.isArray(input.evidence_refs) ||
      input.evidence_refs.length < 1 ||
      input.evidence_refs.length > 8
    )
      throw new StoreError('checkpoint_requires_evidence');
    const refs = [...new Set(input.evidence_refs.map(ref => string(ref, 100)))];
    if (refs.some(ref => !this.references.has(ref)))
      throw new StoreError('unknown_checkpoint_evidence');
    let next: InvestigationCheckpoint['next_check'] = null;
    if (status === 'follow_up') {
      if (!this.canSchedule) throw new StoreError('followup_budget_exhausted');
      const requested = record(input.next_check);
      exactKeys(requested, ['service', 'purpose']);
      const service = string(requested.service, 100);
      const basis = refs.find(ref => this.services.get(service)?.has(ref));
      if (!serviceName(service) || !basis)
        throw new StoreError('followup_service_not_observed');
      next = {
        service,
        purpose: string(requested.purpose, 500),
        basis_ref: basis,
      };
    } else if (input.next_check !== null)
      throw new StoreError('checkpoint_next_check_mismatch');
    return {
      question: string(input.question, 500),
      lead: string(input.lead, 1000),
      result: string(input.result, 1500),
      status: status as InvestigationCheckpoint['status'],
      evidence_refs: refs,
      next_check: next,
      references: refs.map(ref => this.references.get(ref)!),
      recorded_at: new Date().toISOString(),
    };
  }
  settle(checkpoint: InvestigationCheckpoint): InvestigationState {
    return {
      schema_version: 1,
      scope: this.scope,
      followup_used: this.used || Boolean(this.followup),
      checkpoint,
    };
  }
}
