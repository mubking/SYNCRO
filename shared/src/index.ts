/**
 * @synchro/shared
 * 
 * Shared domain models and types for Synchro application
 * Prevents type drift between client, backend, and SDK
 * 
 * Version: 1.0.0
 * Compatibility: Follows semantic versioning
 * - Major version: Breaking changes to domain models
 * - Minor version: New fields (backwards compatible)
 * - Patch version: Bug fixes, documentation
 */

// Subscription models
export * from './subscription';

// Payment models
export * from './payment';

// User models
export * from './user';

// Analytics models
export * from './analytics';

// Common utilities
export * from './common';
