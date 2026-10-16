# Message examples

These are fictional writing examples, not templates to fill mechanically. Names, dates, counts, identifiers, and `example.com` links must not be copied into real posts. Use verified context and the requested audience. Code blocks below show Slack message mrkdwn; do not wrap the actual message in a code block.

## Same incident, different readers

Facts: A startup error blocked three scheduled exports. After the fix, 24 recovery files covering 160 transactions were uploaded. Coverage checks passed. Vendor acceptance and downstream delivery remain unverified. The operations team owns those checks. Existing files must be checked before any retry to avoid duplicates.

### Mixed-audience update

Instead of narrating each check and retry, put the outcome and remaining responsibility first:

```text
*The missing exports have been uploaded:* 24 files covering 160 transactions. Coverage checks passed.

*Still open:* Operations needs to confirm vendor acceptance and downstream delivery. Upload completion does not close the incident.

<https://example.com/recovery-report|Recovery evidence and file list>
```

The retry safeguard stays in the technical record because this update does not ask readers to retry anything. If the message authorizes or describes a retry, include the safeguard in that message.

### Engineering thread reply

The same facts, with the cause and operational condition visible:

```text
*Recovery uploads are complete.* A startup error blocked three scheduled exports; after the fix, 24 recovery files covering 160 transactions were uploaded. Coverage checks passed.

• Operations still needs to confirm vendor acceptance and downstream delivery; the incident remains open.
• Before any retry, check existing files and submissions to avoid duplicates.

<https://example.com/recovery-report|File list and startup-error evidence>
```

An engineering audience justifies useful detail, not a full tool-by-tool transcript. Include exact commands or identifiers when needed for the task; do not invent them to make the message look technical.

## Follow-up: report the change

The thread already explains a request to raise an account limit. The new facts are that support needs a business justification and growth estimate, and the increase is still unapproved. No owner or deadline has been supplied.

Avoid:

```text
Following the previous investigation and review of the support case, I checked the case status again. The support team has now requested additional information concerning the business justification and anticipated growth. The requested increase has not been approved at this time.
```

Prefer:

```text
*The limit increase is waiting on our response.* Support needs the business justification and expected growth. The increase is not approved yet.
```

Do not add a made-up owner, deadline, or claim that a response was sent. If nothing material changed and no update was requested, do not send a message just to announce another check.

## Request: make the ask easy to find

Here the user supplied the reviewer, deadline, and decision needed. The change is proposed, not approved:

```text
Avery, could you review the proposed retry limit by Tuesday at 14:00 UTC?

We need to know whether it could duplicate vendor submissions. <https://example.com/proposal|Proposal and evidence>
```

An FYI does not need an artificial request or a repeated “no action needed” footer.

## Short is not always correct

Source: “We expect the rollout Friday if validation passes. Production approval is still pending.”

- Wrong: “We will roll out Friday.” This changes an estimate into a commitment and removes an approval condition.
- Better: “We expect a Friday rollout, pending validation and production approval.”

A requested recovery plan may need several steps and safeguards. Keep those; shorten repetition around them instead. If asked to send supplied text verbatim, preserve it rather than applying these stylistic examples.
