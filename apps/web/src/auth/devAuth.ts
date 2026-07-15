import type { User } from '@switchboard/shared';
import { apiRequest } from '../api/client.ts';

/** Dev-login user picker source (MOCK): GET /api/v1/auth/dev-users. */
export function listDevUsers(): Promise<User[]> {
  return apiRequest<User[]>('/auth/dev-users');
}
