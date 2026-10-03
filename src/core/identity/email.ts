export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  return normalizeEmail(email).split('@')[1] ?? '';
}

/**
 * The form used only for the signup-bonus key: "+tag" removed everywhere,
 * dots removed for Gmail. ann+1@gmail.com and a.nn@gmail.com are one inbox,
 * so they are one claim. The account keeps the address as entered.
 */
export function canonicalEmail(email: string): string {
  const [local = '', domain = ''] = normalizeEmail(email).split('@');
  const name = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') return `${name.replace(/\./g, '')}@gmail.com`;
  return `${name}@${domain}`;
}
