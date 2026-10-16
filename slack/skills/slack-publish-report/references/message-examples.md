# Message examples

These are fictional writing examples, not templates to fill mechanically. Names, dates, counts, identifiers, and `example.com` links must not be copied into real posts. Use verified context and the requested audience. The short-message examples show Slack mrkdwn; do not wrap the actual message in a code block. The rich examples show tool parameters: their Markdown and block syntax are separate from ordinary mrkdwn.

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

## Investigation summary: native Markdown

Use a compact table when it makes comparisons easier. Supply both the visible `markdown` and an essential-content `text` fallback. This is a draft payload, not authorization to post:

```json
{
  "channel": "C0123456789",
  "text": "Recovery uploads are complete: 24 files covering 160 transactions. Coverage passed. Vendor acceptance and downstream delivery remain unverified; the incident is open. Operations owns those checks. Before any retry, check existing files/submissions to avoid duplicates. Evidence: https://example.com/recovery-report",
  "markdown": "## Export recovery\n**Uploads complete; incident still open.** Operations still needs to verify vendor acceptance and downstream delivery.\n\n| Check | Result |\n| --- | --- |\n| Recovery uploads | 24 files / 160 transactions |\n| Coverage | Passed |\n| Acceptance and delivery | Unverified |\n\nBefore any retry, check existing files/submissions to avoid duplicates.\n\n[Recovery evidence](https://example.com/recovery-report)"
}
```

One status, one table, one necessary safeguard, one evidence link. A short follow-up should still be a sentence or two, not another full report.

## Recurring dashboard: static blocks

Use metric fields for a small set of related numbers. A context footer is for sources or secondary context, not qualifications that change the headline. Here the status icon has a text label; no decorative icons are needed elsewhere.

```json
{
  "channel": "C0123456789",
  "text": "Daily cost: projected month-end $101,000, or 101% of the $100,000 budget. This is a projection, not final spend. Yesterday: $3,200; same-weekday median: $3,100. No cause has been established for the difference. Cost evidence: https://example.com/cost",
  "blocks": [
    {"type": "header", "text": {"type": "plain_text", "text": "Daily cost"}},
    {"type": "section", "text": {"type": "mrkdwn", "text": ":red_circle: *Projected over budget*\nMonth-end *$101,000* · *101%* of $100,000. Projection, not final spend."}},
    {"type": "divider"},
    {"type": "section", "fields": [
      {"type": "mrkdwn", "text": "*Yesterday*\n$3,200"},
      {"type": "mrkdwn", "text": "*Same-weekday median*\n$3,100"}
    ]},
    {"type": "section", "text": {"type": "mrkdwn", "text": "*Finding:* No cause has been established for the difference."}},
    {"type": "context", "elements": [{"type": "mrkdwn", "text": "<https://example.com/cost|Cost evidence>"}]}
  ]
}
```

For a longer comparison, a static `table` uses `rows` of cells such as `{"type":"raw_text","text":"Production"}` and `{"type":"raw_number","value":3200,"text":"3,200"}`. Use `column_settings` for wrapping or right-aligned numbers. Prefer a real table to manually padded spaces inside a code block. For formatted cells, use a Markdown table instead.

## Short is not always correct

Source: “We expect the rollout Friday if validation passes. Production approval is still pending.”

- Wrong: “We will roll out Friday.” This changes an estimate into a commitment and removes an approval condition.
- Better: “We expect a Friday rollout, pending validation and production approval.”

A requested recovery plan may need several steps and safeguards. Keep those; shorten repetition around them instead. If asked to send supplied text verbatim, preserve it rather than applying these stylistic examples.
