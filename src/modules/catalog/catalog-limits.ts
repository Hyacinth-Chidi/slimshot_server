export const CATALOG_LIMITS = Symbol('CATALOG_LIMITS');

/** Requests per minute per client IP. */
export interface CatalogLimits {
  readPerMinute: number;
  downloadPerMinute: number;
}

export const DEFAULT_CATALOG_LIMITS: CatalogLimits = { readPerMinute: 120, downloadPerMinute: 30 };
