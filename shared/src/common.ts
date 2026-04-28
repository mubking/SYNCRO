/**
 * Common shared types and utilities
 */

/**
 * Paginated API response wrapper
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

/**
 * API error response
 */
export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
}

/**
 * Success response wrapper
 */
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Timestamp fields for entities
 */
export interface Timestamps {
  createdAt: string;
  updatedAt: string;
}

/**
 * Soft delete support
 */
export interface SoftDeletable {
  deletedAt?: string | null;
}

/**
 * Currency code (ISO 4217)
 */
export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'JPY' | string;

/**
 * Locale code (BCP 47)
 */
export type LocaleCode = 'en-US' | 'en-GB' | 'es-ES' | 'fr-FR' | 'de-DE' | string;
