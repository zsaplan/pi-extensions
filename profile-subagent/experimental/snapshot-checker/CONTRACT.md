# Experimental JSON structural comparison v1

Declared before implementation/live trials. This is a narrow observation-level contract, not general configuration semantics or a promoted profile.

- Exactly two complete text observations obtained through the parent's `read` pipeline. Bind requested paths and SHA-256 hashes of returned text; do not certify physical files, deployment freshness or unredacted originals.
- Strict JSON with object roots. Strings, booleans, null, objects, ordered arrays and safe integer literals only. Reject fractions/exponents, unsafe integers, duplicate decoded keys, malformed JSON and unsupported roots. No YAML, comments, implicit coercion or identity-based array matching.
- At most 32 KiB UTF-8 per observation, nesting depth 32, 2,000 nodes per observation and 128 changed nodes. Reject oversized delivered reports rather than returning a truncated verified inventory (16 KiB compact JSON budget).
- Compare every node by escaped JSON Pointer. Scalar descriptors contain type and exact value; container descriptors contain type only. Emit changed/added/removed node descriptors, including container-type transitions and descendant additions/removals. Object key order is immaterial; array positions are significant. A subtree replacement does not replace the detailed node inventory.
- Each present-side descriptor has a 1-based source start/end line; missing sides are explicit null. Counts account for before/after nodes, changed paths and unchanged paths. Hash the complete delivered inventory, not the model's narrative.
- Generate the inventory from a duplicate-detecting source parser. Validate the delivered inventory against a separate native-JSON traversal of the same observations, plus source-span checks. Shared contract/parser bugs remain possible; independently authored fixtures and corruption checks are required.
- Tool-result checks use only post-parent-permission/redaction observations. Runtime handoff accepts only an unchanged checker result bound to the actual enclosing tool call and parent session, after result hooks have run. Altered/redacted/forged/replayed checker output does not acquire an attestation. No raw cached result is re-exposed to repair a failed check.
- The specialist's narrative is never mechanically verified. Only the original attached inventory is eligible for observation-level reliance. Exactly one successful comparison is eligible per experimental child; failure, repeated calls, lost receipt or incomplete child output prevents a checked handoff.
- Comparator registration is opt-in through a separate experimental extension. Its experimental profile also requires explicit operator enablement. Existing pilot, installed registration/settings and unrelated parent verification remain unchanged.

## Failure-first mechanical checks

Incorrect values/types, missed/extra/duplicate changes, wrong before/after or input hash, wrong nested pointer/span, coarse root replacements, malformed/duplicate-key inputs, unsafe numbers, unapproved array semantics, truncated/oversized observations and output, parent denial/redaction, forged or replayed receipts, misleading child prose and multiple comparisons must not pass as a checked complete handoff. Independently specified unchanged, subtle-change, nested-name, addition/removal/type and ordered-array cases must succeed.

## Experiment boundary

After mechanics pass, freeze a separate H013/E026 live plan before launch. Compare direct model review, model-free checker output and a checker-backed specialist on fresh synthetic held-out cases, with independent expected answers written separately from the comparator. These are assistant-authored/reviewed expectations, not independent human acceptance. Specialist use is fixed for this mechanism diagnostic, not evidence of natural routing.

Maximum ten paid parent CLI trials, 180 seconds each; $3 cumulative known reported-cost review threshold, not a hard billing cap. No retries/replacements or tuning after live launch. One isolated incomplete transport measurement may be retained while remaining safe trials continue; a second affected trial, repeated transport failure in one trial, or any authority/setup/integrity/cleanup failure stops. Mechanical defects discovered before launch may be fixed with failures preserved. Any post-launch code/input change requires a new study and renewed direction. No live systems, operational data, installation or automatic promotion.
