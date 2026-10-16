import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

type RecordEntry = {
  integrity: string;
  isError: boolean;
  content: Array<{type: string; text: string}>;
};

// Verify the actual SDK child transcript against the original post-hook packet.
// Never consult raw adapter receipts or reconstruct an omitted observation.
export async function checkGithubRetention(report: Record<string, unknown>) {
  const packet = report.sourceEvidence as {
    records: RecordEntry[];
    omitted: number;
    budget: {limitBytes: number; usedBytes: number; remainingBytes: number};
  };
  const bytes = Buffer.byteLength(JSON.stringify(packet.records));
  assert.ok(bytes <= 49152);
  assert.deepEqual(packet.budget, {
    limitBytes: 49152,
    usedBytes: bytes,
    remainingBytes: 49152 - bytes,
  });
  const prefixes = new Map(
    packet.records.map((record, i) => [
      Buffer.byteLength(JSON.stringify(packet.records.slice(0, i + 1))),
      record,
    ]),
  );
  const messages = JSON.parse(
    await readFile(join(String(report.artifactDir), 'messages.json'), 'utf8'),
  ) as Array<{
    role: string;
    isError: boolean;
    details?: unknown;
    content: Array<{type: string; text: string}>;
  }>;
  let checked = 0,
    gaps = 0;
  for (const message of messages.filter(m => m.role === 'toolResult')) {
    let delivered;
    try {
      delivered = JSON.parse(message.content.at(-1)!.text);
    } catch {
      continue;
    }
    const retention = delivered.evidenceRetention;
    if (!retention) continue; // Pre-adapter schema/handle failures have no source.
    checked++;
    assert.equal(retention.limitBytes, 49152);
    assert.equal(retention.remainingBytes, 49152 - retention.usedBytes);
    assert.ok(retention.usedBytes >= 2 && retention.usedBytes <= bytes);
    assert.ok(
      message.content.reduce(
        (n, p) =>
          n + Buffer.byteLength(p.type === 'text' ? p.text : JSON.stringify(p)),
        0,
      ) <= 16384,
    );
    assert.equal(message.details, undefined);
    delete delivered.evidenceRetention;
    if (retention.retained) {
      const record = prefixes.get(retention.usedBytes);
      assert.ok(
        record,
        'Child budget must identify an actually retained prefix',
      );
      assert.equal(message.isError, record.isError);
      if (record.integrity === 'intact-adapter-observation') {
        const original = JSON.parse(record.content[0].text);
        assert.deepEqual(
          delivered,
          original,
          'Child source differs from retained post-hook evidence',
        );
        assert.equal(
          retention.usableReferences,
          original.status === 'ok' && !original.credentialRedacted,
        );
      } else {
        assert.equal(retention.usableReferences, false);
        assert.deepEqual(message.content.slice(0, -1), record.content);
      }
    } else {
      gaps++;
      assert.equal(retention.usableReferences, false);
      assert.equal(message.isError, true);
      assert.equal(message.content.length, 1);
      assert.deepEqual(Object.keys(delivered).sort(), ['reason', 'status']);
      assert.equal(delivered.status, 'unavailable');
      assert.match(delivered.reason, /not retained or delivered/);
      assert.ok(retention.usedBytes === 2 || prefixes.has(retention.usedBytes));
    }
  }
  assert.ok(gaps <= packet.omitted);
  return {checked, gaps, packetBytes: bytes};
}
