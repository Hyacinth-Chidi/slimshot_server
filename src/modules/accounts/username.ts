export const RESERVED_USERNAMES = new Set([
  'account', 'admin', 'administrator', 'api', 'billing', 'credits', 'help', 'me', 'mod', 'moderator',
  'null', 'official', 'root', 'security', 'settings', 'slimshot', 'slimshotai', 'staff', 'support',
  'system', 'team', 'undefined',
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** For a normalised name: why it cannot be used, or null. */
export function usernameProblem(name: string): 'INVALID' | 'RESERVED' | null {
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return 'INVALID';
  if (RESERVED_USERNAMES.has(name)) return 'RESERVED';
  return null;
}
