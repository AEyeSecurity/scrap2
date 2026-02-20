import type { ApiFetchResult, NormalizedRecord } from './types';

function toRows(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }

  if (body && typeof body === 'object') {
    const maybeObject = body as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'rows']) {
      const value = maybeObject[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [body];
}

export function normalizeApiResults(results: ApiFetchResult[]): NormalizedRecord[] {
  const normalized: NormalizedRecord[] = [];

  for (const result of results) {
    const rows = toRows(result.body);

    rows.forEach((row, index) => {
      normalized.push({
        source: 'api',
        endpoint: result.endpoint,
        recordIndex: index,
        extractedAt: result.fetchedAt,
        payloadJson: JSON.stringify(row)
      });
    });
  }

  return normalized;
}
