# Capability guide

Use current search/list results for the session's actual catalog and callable tools. This guide explains the bundled roles; it is not proof of enablement, connectivity, correctness or usefulness. Model prose remains unverified, and completion does not authorize changes.

| Role | Intended work | Important limit |
|---|---|---|
| `configuration-drift-reviewer` | Compare two supplied rendered configuration snapshots | No rendering, cluster access, edits or verified runtime impact |
| `documentation-consistency-reviewer` | Check documentation claims against supplied source | No edits or runtime tests |
| `postfix-investigator` | Classify named postfix findings for one site | Read-only; no repair package or execution |
| `postfix-repair-planner` | Validate one missing outcome and propose a repair package | Never executes the repair |
| `postfix-repair-reviewer` | Challenge one proposed repair package | Never executes or approves it |
| `configuration-checked-reviewer` | One bounded strict-JSON structural comparison | Operator-opted-in pilot; two explicit paths, no semantic array matching or impact claims |

The original five require callable `read`, `grep`, `find`, `ls`; postfix roles also require the three approved `bc_site_db_*` tools in their manifests. Missing tools are an access/configuration issue, not evidence that a new role is needed.

The checked pilot is hidden unless the operator starts Pi with `--profile-subagent-checked-pilot`. Its absence in search/list can therefore mean **disabled**, not unimplemented. It requires parent `read` and the internal checker, and `profile_subagent_run` arguments include `snapshots: {before, after}`. Preparing a request does not authorize enabling it. Loading this skill does not require that flag; `/reload` loads skills but does not add startup flags.

Children receive trusted profile instructions and the explicit task, **not the parent's conversation**. Specify evidence paths, scope, desired result and restrictions. Rely only on evidence that supports the conclusion; resolve consequential gaps without automatically repeating the whole investigation. A proposed new specialist should reduce useful parent work, not merely move it into another model call.

No unrestricted fallback or dynamic project/remote/request-file profile loading is supported. Requests remain documents, outside the executable catalog. An appropriate response may be to use an existing role, fix configuration with approval, keep the work direct, or develop a narrow new role.

See [the package guide](../../README.md) for current invocation, evidence and privacy details. Do not infer that the checked pilot's Luna configuration or its narrow results qualify other roles or proposed profiles.
