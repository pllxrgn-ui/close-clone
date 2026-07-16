/*
 * MSW mock for GET /admin/custom-fields — the custom-field catalog the builder's
 * field picker consumes. Lives in the feature (not the W1 mocks/ directory,
 * which another sprint task owns) and is registered two ways:
 *   - tests: `server.use(...viewBuilderHandlers)` (see ViewBuilderPage.test.tsx),
 *   - dev runtime: the orchestrator spreads it into the W1 handler list at merge
 *     (see the task report's routeWiring).
 *
 * The fixture mixes lead / contact / opportunity entities on purpose: the builder
 * must surface ONLY lead-entity fields (the parser resolves `custom.<key>` for
 * lead fields alone), which the page test asserts.
 */
import { http, HttpResponse } from 'msw';
import type { AdminCustomField } from './api.ts';

export const MOCK_CUSTOM_FIELDS: AdminCustomField[] = [
  {
    id: '11111111-1111-4111-8111-111111111101',
    entity: 'lead',
    key: 'segment',
    label: 'Segment',
    type: 'select',
    options: ['SMB', 'Mid-Market', 'Enterprise'],
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111102',
    entity: 'lead',
    key: 'region',
    label: 'Region',
    type: 'select',
    options: ['NA-East', 'NA-West', 'EMEA', 'APAC', 'LATAM'],
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111103',
    entity: 'lead',
    key: 'employees',
    label: 'Employees',
    type: 'number',
    options: null,
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111104',
    entity: 'lead',
    key: 'renewal_date',
    label: 'Renewal date',
    type: 'date',
    options: null,
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111105',
    entity: 'lead',
    key: 'champion',
    label: 'Champion',
    type: 'user',
    options: null,
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111106',
    entity: 'lead',
    key: 'notes',
    label: 'Account notes',
    type: 'text',
    options: null,
    required: false,
  },
  // Non-lead entities — must be filtered out of the builder's field picker.
  {
    id: '11111111-1111-4111-8111-111111111201',
    entity: 'contact',
    key: 'persona',
    label: 'Persona',
    type: 'select',
    options: ['Champion', 'Blocker', 'Economic buyer'],
    required: false,
  },
  {
    id: '11111111-1111-4111-8111-111111111301',
    entity: 'opportunity',
    key: 'forecast_category',
    label: 'Forecast category',
    type: 'select',
    options: ['Commit', 'Best case', 'Pipeline'],
    required: false,
  },
];

export const viewBuilderHandlers = [
  http.get('*/api/v1/admin/custom-fields', () => HttpResponse.json(MOCK_CUSTOM_FIELDS)),
];
