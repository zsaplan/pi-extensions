import {receipts, type Receipt} from './intake.ts';
import {associatedSources, workLinks} from './related-work.ts';
import {isOwnerThreadReply} from './owner-references.ts';
import {isReviewerResult} from './reviewer-handoff.ts';
import {StoreError, type Source, type Task, type TaskStore} from './store.ts';

export interface CompletionAuthority {
  receipt_id: string;
  content_hash: string;
}

function ownerSource(task: Task, receipt: Receipt, sources: Source[]) {
  return (
    receipt.content_source === 'conversation' &&
    !receipt.evidence_kind &&
    receipt.kind !== 'task_reply' &&
    receipt.author_id === task.inbox.owner_user_id &&
    receipt.source.workspace_id === task.inbox.workspace_id &&
    /^[CG][A-Z0-9]+$/.test(receipt.source.channel_id) &&
    sources.some(
      source =>
        source.workspace_id === receipt.source.workspace_id &&
        source.channel_id === receipt.source.channel_id &&
        (source.thread_ts ?? source.message_ts) ===
          (receipt.source.thread_ts ?? receipt.source.message_ts),
    )
  );
}

// Identity and scope authorize ONLY recognizing reported completion. The worker judges
// whether the owner's actual words mean this task is complete, not approved or planned.
export function completionCandidates(
  task: Task,
  updates: Receipt[],
  observed: Receipt[],
  sources: Source[],
) {
  const ownerMessages = observed.filter(
    r =>
      ownerSource(task, r, sources) ||
      (r.content_source === 'conversation' &&
        !r.evidence_kind &&
        isOwnerThreadReply(task, r)),
  );
  const latest = ownerMessages.sort(
    (a, b) => Number(b.source.message_ts) - Number(a.source.message_ts),
  )[0];
  // Pending canonical owner input can veto an older completion even while the
  // classifier is busy. Only routed input may supply positive closure authority.
  return updates.filter(
    r =>
      r.disposition === 'routed' &&
      r.task_id === task.id &&
      r.id === latest?.id &&
      r.content_hash === latest.content_hash &&
      ownerSource(task, r, sources),
  );
}

export async function validateCompletion(
  store: TaskStore,
  task: Task,
  proof: CompletionAuthority,
) {
  if (
    !/^[a-f0-9]{64}$/.test(proof.receipt_id) ||
    !/^[a-f0-9]{64}$/.test(proof.content_hash)
  )
    throw new StoreError('invalid_completion_authority');
  const observed = await receipts(store);
  const saved = observed.find(r => r.id === proof.receipt_id);
  const related = await associatedSources(store, [task], observed);
  if (
    !saved ||
    saved.content_hash !== proof.content_hash ||
    !completionCandidates(task, [saved], observed, [
      ...task.sources,
      ...related.map(a => a.source),
    ]).length
  )
    throw new StoreError('owner_completion_changed');
}

// Silence is not a claim that another process accepted or started the request.
// Limit this exception to explicit review requests in an already-observed workflow.
export function quietReviewRequestAllowed(
  task: Task,
  updates: Receipt[],
  observed: Receipt[],
) {
  const owner = updates.filter(r => isOwnerThreadReply(task, r));
  const reviewed = new Set(
    observed
      .filter(
        r =>
          r.task_id === task.id &&
          r.disposition === 'routed' &&
          isReviewerResult(task, r),
      )
      .flatMap(r => workLinks(r.text)),
  );
  return (
    owner.length > 0 &&
    owner.every(
      r =>
        r.content_source === 'conversation' &&
        !r.evidence_kind &&
        r.text.includes(`<@${task.inbox.bot_user_id}>`) &&
        /\b(?:re-?review|review)\b/i.test(r.text) &&
        !/\?|\b(?:why|what|which|when|how|explain|summarize)\b/i.test(r.text) &&
        workLinks(r.text).some(key => reviewed.has(key)),
    )
  );
}
