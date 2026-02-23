export interface DepositRowCandidate {
  index: number;
  hasAction: boolean;
  usernames: string[];
  normalizedText: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeDepositText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasExactUsernameMatch(value: string, username: string): boolean {
  const normalizedValue = normalizeDepositText(value);
  const normalizedUsername = normalizeDepositText(username);
  if (!normalizedValue || !normalizedUsername) {
    return false;
  }

  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegex(normalizedUsername)}([^a-z0-9_]|$)`, 'i');
  return pattern.test(normalizedValue);
}

export function selectDepositRowIndex(candidates: DepositRowCandidate[], username: string): number {
  const actionable = candidates.filter((candidate) => candidate.hasAction);
  if (actionable.length === 0) {
    throw new Error(`No actionable rows found while searching for user "${username}"`);
  }

  const exact = actionable.filter((candidate) => {
    if (candidate.usernames.some((value) => hasExactUsernameMatch(value, username))) {
      return true;
    }

    return hasExactUsernameMatch(candidate.normalizedText, username);
  });

  if (exact.length === 1) {
    return exact[0].index;
  }

  if (exact.length > 1) {
    throw new Error(`Multiple exact matches found for user "${username}" (${exact.length})`);
  }

  throw new Error(`Could not find an exact unique match for user "${username}" in users list (actionable rows: ${actionable.length}).`);
}
