export const parentDelegationGuidance = [
  'Delegation is optional. Handle simple bounded checks directly when child setup would outweigh useful work.',
  'For substantial work sharing a target, source and evidence, prefer one combined assignment if the trusted role permits that scope and its budget fits. Never widen a role or its limits to combine work.',
  'Consider parallel specialists for genuinely distinct, independent contexts; finding count alone is not a reason to split. Weigh repeated setup, parent verification and total parent-plus-child cost, not child speed alone.',
  'Give each child exact scope/target/environment, evidence paths, expected outcome and restrictions; distinguish prior leads from verified facts.',
  'As parent, inspect cited source/results supporting material conclusions and the reported verification gaps. Resolve gaps that could change the answer with targeted reads or allowed queries; do not blindly accept the summary or repeat the whole investigation.',
  'Check failed/truncated results and retrieve only the needed artifact sections, or report an incomplete conclusion. Recheck mutable evidence when freshness matters. Retain failed and unperformed checks; completion never authorizes further actions.',
].join(' ');

export const childEvidenceHandoff = [
  '# Evidence handoff',
  'Within the assigned role and its required output format, return one concise Markdown report covering every assigned item. Reuse shared setup/evidence rather than repeating it per finding.',
  'For each item give the conclusion/classification, decisive observed evidence and separate inference. Cite source file:line and query/saved-query reference with actual results or counts; include target and observation time when available and relevant.',
  'Include a compact verification checklist: decision-changing checks verified, unresolved, or not applicable with a reason. Preserve failed attempts, contradictory evidence and important unperformed checks. Narrow conclusions when evidence is incomplete.',
  'Reference existing evidence/artifacts and precise locations for deeper inspection instead of copying raw transcripts. Do not invent paths or write evidence files without permission; the runner saves the report and transcript and returns their paths.',
  'Keep the decisive evidence and limitations prominent. Brevity must not hide gaps or turn an unperformed check into a passed check.',
].join('\n\n');
