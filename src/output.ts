import path from 'node:path';
import { promises as fs } from 'node:fs';
import { stringify } from 'csv-stringify/sync';
import type { NormalizedRecord, RunMetadata } from './types';

function timestampId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function writeOutputs(outputDir: string, records: NormalizedRecord[], metadata: Omit<RunMetadata, 'outputJson' | 'outputCsv'>): Promise<RunMetadata> {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = timestampId();

  const jsonPath = path.join(outputDir, `data.${stamp}.json`);
  const csvPath = path.join(outputDir, `data.${stamp}.csv`);
  const metaPath = path.join(outputDir, `run.${stamp}.meta.json`);

  await fs.writeFile(jsonPath, JSON.stringify(records, null, 2), 'utf8');

  const csv = stringify(records, {
    header: true,
    columns: ['source', 'endpoint', 'recordIndex', 'extractedAt', 'payloadJson']
  });

  await fs.writeFile(csvPath, csv, 'utf8');

  const fullMeta: RunMetadata = {
    ...metadata,
    outputJson: jsonPath,
    outputCsv: csvPath
  };

  await fs.writeFile(metaPath, JSON.stringify(fullMeta, null, 2), 'utf8');

  return fullMeta;
}
