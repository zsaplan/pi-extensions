# Specialist evaluation (v1)

Frozen corpus SHA-256: `2a37904a850578167d3a9d740d06973914e05db0042d275c84594a6f5037e19f`.

The 18 cases contain 12 clear tasks (four per family, two development and two held-out), three ambiguous controls and three unsupported controls. Nine clear cases carry quality rubrics: six complete and three evidence gaps. Use only development cases for metadata/ranking adjustments. Do not tune against held-out failures; record them and freeze a new evaluation revision if needed.

Fixtures are synthetic. No production credentials, data, mutations, or live DB services are involved. The test DB tools return the supplied current-state fixture, not SQL-engine results.

## Failure modes and evidence

- Wrong/absent retrieval: record every rank, including missing IDs; H1 requires 11/12 overall, 3/4 per family, 5/6 held-out.
- Correct candidates but wrong parent choice: record actual search and run calls; H2 requires 11/12 clear choices in each of two sweeps and all controls to avoid launches. Ambiguous cases must ask for missing scope.
- Missing context or invented findings: review child input/messages/result against each rubric, recording citations, material findings and missing prerequisites. H3 requires every scored case in both sweeps; a wrong role is a failure, not an excuse to rerun by name.
- Capability leakage: file hooks restrict access to the temporary fixture tree; only synthetic DB tools are registered. Labels, rubrics, repo files and credentials are outside that tree. Existing deterministic permission tests remain necessary.
- Failed/empty/aborted runs: record them; never discard a run or count it as successful work.

## Repeat

From the repository root:

```bash
npm run test --workspace profile-subagent
PI_PROVIDER=openai-codex PI_MODEL=gpt-6-astra PI_THINKING=low \
  node profile-subagent/test/evaluate.mjs
```

`PI_PROVIDER`, `PI_MODEL`, and `PI_THINKING` select the **parent** only. Children use `openai-codex/gpt-6.1-sol` / medium; the report records these defaults separately and each child result identifies its model/thinking. The earlier Astra/low child attempt remains historical, not acceptance for this configuration.

The live harness runs two fresh sweeps and writes private evidence under `profile-subagent/tmp/evaluation/`. It records exact prompts, versions, corpus/code/profile hashes, invocations, stdout/stderr, candidates, actual calls, usage, child artifacts and errors. It copies only case evidence into each model-visible workspace. Local authentication stays on Pi's existing credential path; no keys are captured.

The automated report scores retrieval and clear-task selection mechanically. Control responses and H3 require human/agent evidence review in a separate `review.json` file: per case/sweep, record pass/fail, evidence references and reasons. Do not infer quality from exit code, keyword counts, or completion status. Add review totals to the OpenSpec tasks with evidence paths; do not archive failed or unreviewed gates.

These are pilot tests, not statistical proof or production repair acceptance.
