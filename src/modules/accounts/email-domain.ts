import { emailDomain } from '../../core/identity/email';

/** True for a listed disposable domain or any subdomain of one. */
export function isDisposable(email: string, domains: string[]): boolean {
  const domain = emailDomain(email);
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}
