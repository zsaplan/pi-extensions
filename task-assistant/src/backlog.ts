import {digest, exactKeys, record, StoreError} from './store.ts';

export interface BacklogApproval {
  schema_version: 1;
  id: string;
  approved_at: string;
  regular_approval_hash: string;
  previous_approval_hash: string | null;
  limits: {max_tracked_tasks: number; model_minutes_per_day: number};
}
export interface ModelReservation {
  id: string;
  kind: 'classification' | 'investigation';
  reference: string;
  seconds: number;
  reserved_at: string;
}
export interface BacklogState {
  approvals: BacklogApproval[];
  reservations: ModelReservation[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const seconds = {classification: 60, investigation: 120};
export const MODEL_RESERVATION_SECONDS = seconds;
export const BACKLOG_THREAD_FEEDS_PER_POLL = 40;
const day = 86400000;
const time = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

// The regular approval still owns feeds, cutoff, identities and tools. This
// append-only approval changes capacity only; it cannot renew an old trial.
export function configureBacklog(
  saved: BacklogState | undefined,
  supplied: unknown,
  regularApproval: Record<string, unknown>,
): BacklogState {
  const regularHash = digest(JSON.stringify(regularApproval));
  const validate = (value: unknown): BacklogApproval => {
    const a = record(value);
    exactKeys(a, [
      'schema_version',
      'id',
      'approved_at',
      'regular_approval_hash',
      'previous_approval_hash',
      'limits',
    ]);
    const limits = record(a.limits);
    exactKeys(limits, ['max_tracked_tasks', 'model_minutes_per_day']);
    if (
      a.schema_version !== 1 ||
      typeof a.id !== 'string' ||
      !uuid.test(a.id) ||
      !time(a.approved_at) ||
      Date.parse(a.approved_at) > Date.now() ||
      Date.parse(a.approved_at) <
        Date.parse(String(regularApproval.approved_at)) ||
      a.regular_approval_hash !== regularHash ||
      !(
        a.previous_approval_hash === null ||
        (typeof a.previous_approval_hash === 'string' &&
          /^[a-f0-9]{64}$/.test(a.previous_approval_hash))
      ) ||
      !Number.isInteger(limits.max_tracked_tasks) ||
      Number(limits.max_tracked_tasks) < 1 ||
      Number(limits.max_tracked_tasks) > 50 ||
      !Number.isInteger(limits.model_minutes_per_day) ||
      Number(limits.model_minutes_per_day) < 2 ||
      Number(limits.model_minutes_per_day) > 1440
    )
      throw new StoreError('invalid_backlog_approval');
    return a as unknown as BacklogApproval;
  };
  const approval = validate(supplied);
  const state = saved ?? {approvals: [], reservations: []};
  exactKeys(record(state), ['approvals', 'reservations']);
  if (saved && (!Array.isArray(saved.approvals) || !saved.approvals.length))
    throw new StoreError('invalid_backlog_history');
  if (
    !Array.isArray(state.approvals) ||
    !Array.isArray(state.reservations) ||
    state.approvals.length > 100 ||
    state.reservations.length > 10000
  )
    throw new StoreError('invalid_backlog_state');
  const ids = new Set<string>();
  let previous: BacklogApproval | undefined;
  for (const item of state.approvals) {
    validate(item);
    if (
      ids.has(item.id) ||
      item.previous_approval_hash !==
        (previous ? digest(JSON.stringify(previous)) : null) ||
      (previous &&
        Date.parse(item.approved_at) < Date.parse(previous.approved_at))
    )
      throw new StoreError('invalid_backlog_history');
    ids.add(item.id);
    previous = item;
  }
  const reservationIds = new Set<string>();
  for (const value of state.reservations) {
    const item = record(value);
    exactKeys(item, ['id', 'kind', 'reference', 'seconds', 'reserved_at']);
    if (
      typeof item.id !== 'string' ||
      !uuid.test(item.id) ||
      reservationIds.has(item.id) ||
      !['classification', 'investigation'].includes(String(item.kind)) ||
      item.seconds !== seconds[item.kind as keyof typeof seconds] ||
      typeof item.reference !== 'string' ||
      !/^[a-z0-9:-]{1,200}$/.test(item.reference) ||
      !time(item.reserved_at) ||
      Date.parse(item.reserved_at) > Date.now() ||
      !state.approvals.length ||
      Date.parse(item.reserved_at) < Date.parse(state.approvals[0].approved_at)
    )
      throw new StoreError('invalid_model_reservation');
    reservationIds.add(item.id);
  }
  if (previous?.id === approval.id) {
    if (JSON.stringify(previous) !== JSON.stringify(approval))
      throw new StoreError('backlog_scope_mismatch');
    return state;
  }
  if (
    ids.has(approval.id) ||
    state.approvals.length >= 100 ||
    approval.previous_approval_hash !==
      (previous ? digest(JSON.stringify(previous)) : null) ||
    (previous &&
      Date.parse(approval.approved_at) < Date.parse(previous.approved_at))
  )
    throw new StoreError('backlog_requires_latest_approval');
  return {...state, approvals: [...state.approvals, approval]};
}

export function modelBudget(state: BacklogState) {
  const now = Date.now();
  const current = state.reservations.filter(
    r => Date.parse(r.reserved_at) > now - day,
  );
  const limit = state.approvals.at(-1)!.limits.model_minutes_per_day * 60;
  const reserved = current.reduce((sum, r) => sum + r.seconds, 0);
  return {
    limit_seconds: limit,
    reserved_seconds: reserved,
    remaining_seconds: Math.max(0, limit - reserved),
  };
}
export function nextModelSlot(
  state: BacklogState,
  needed: number,
): string | null {
  const budget = modelBudget(state);
  let available = budget.limit_seconds - budget.reserved_seconds;
  if (available >= needed) return null;
  for (const r of [...state.reservations]
    .filter(r => Date.parse(r.reserved_at) > Date.now() - day)
    .sort((a, b) => a.reserved_at.localeCompare(b.reserved_at))) {
    available += r.seconds;
    if (available >= needed)
      return new Date(Date.parse(r.reserved_at) + day).toISOString();
  }
  return null;
}

export function currentReservations(state: BacklogState): ModelReservation[] {
  return state.reservations.filter(
    r => Date.parse(r.reserved_at) > Date.now() - day,
  );
}
