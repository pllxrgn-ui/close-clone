import type { SmartView } from '@switchboard/shared';
import { apiRequest } from './client.ts';
import type {
  SmartViewCreate,
  SmartViewPreviewRequest,
  SmartViewPreviewResponse,
  SmartViewUpdate,
} from './types.ts';

export function listSmartViews(): Promise<SmartView[]> {
  return apiRequest<SmartView[]>('/smart-views');
}

export function getSmartView(id: string): Promise<SmartView> {
  return apiRequest<SmartView>(`/smart-views/${encodeURIComponent(id)}`);
}

export function createSmartView(input: SmartViewCreate): Promise<SmartView> {
  return apiRequest<SmartView>('/smart-views', { method: 'POST', body: input });
}

export function updateSmartView(id: string, input: SmartViewUpdate): Promise<SmartView> {
  return apiRequest<SmartView>(`/smart-views/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteSmartView(id: string): Promise<void> {
  return apiRequest<void>(`/smart-views/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /smart-views/preview — first page + count-estimate for a {dsl|ast}. */
export function previewSmartView(
  input: SmartViewPreviewRequest,
): Promise<SmartViewPreviewResponse> {
  return apiRequest<SmartViewPreviewResponse>('/smart-views/preview', {
    method: 'POST',
    body: input,
  });
}
