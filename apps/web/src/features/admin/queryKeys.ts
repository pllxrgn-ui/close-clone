/*
 * React-query keys for the admin feature's own resources. Centralized so the
 * settings sections and the bulk enroll action invalidate the same caches (a
 * bulk enroll ticks a sequence's count → the sequence picker / list refetch).
 */
export const SEQUENCES_QUERY_KEY = ['admin', 'sequences'] as const;
export const CUSTOM_FIELDS_QUERY_KEY = ['admin', 'custom-fields'] as const;
export const TEMPLATES_QUERY_KEY = ['admin', 'templates'] as const;
export const SNIPPETS_QUERY_KEY = ['admin', 'snippets'] as const;
export const ORG_SETTINGS_QUERY_KEY = ['admin', 'org-settings'] as const;
export const USERS_QUERY_KEY = ['ref', 'users'] as const;
export const LEAD_STATUSES_QUERY_KEY = ['ref', 'lead-statuses'] as const;
