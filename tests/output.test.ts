import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { writeOutputs } from '../src/output';

describe('writeOutputs', () => {
  it('writes JSON, CSV and metadata files', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'scraper-out-'));

    const metadata = await writeOutputs(
      out,
      [
        {
          source: 'api',
          endpoint: '/api/foo',
          recordIndex: 0,
          extractedAt: '2026-02-20T00:00:00.000Z',
          payloadJson: '{"id":1}'
        }
      ],
      {
        startedAt: '2026-02-20T00:00:00.000Z',
        endedAt: '2026-02-20T00:00:01.000Z',
        durationMs: 1000,
        records: 1,
        apiCalls: 1,
        retries: 2,
        errors: []
      }
    );

    const json = await readFile(metadata.outputJson, 'utf8');
    const csv = await readFile(metadata.outputCsv, 'utf8');
    const meta = await readFile(path.join(out, path.basename(metadata.outputJson).replace('data.', 'run.').replace('.json', '.meta.json')), 'utf8');

    expect(json).toContain('"/api/foo"');
    expect(csv).toContain('endpoint');
    expect(meta).toContain('"records": 1');
  });
});
