/**
 * Plain-data fixture shapes (CONTRACTS §C1). These are deliberately DB-free:
 * no Drizzle, no zod, no imports from the app — just the columns a golden/latency
 * dataset needs. Absent values are `null` (not optional) to keep records uniform
 * and JSON round-trip stable.
 */

export interface EmailEntry {
  email: string;
  type: string;
}

export interface PhoneEntry {
  phone: string;
  type: string;
}

export interface LeadRecord {
  id: string;
  name: string;
  url: string;
  description: string;
  status: string;
  ownerId: string;
  custom: Record<string, string | number | boolean>;
  dnc: boolean;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  nextTaskDueAt: string | null;
  lastCallAt: string | null;
  lastEmailAt: string | null;
  lastSmsAt: string | null;
  createdAt: string;
}

export interface ContactRecord {
  id: string;
  leadId: string;
  name: string;
  title: string;
  emails: EmailEntry[];
  phones: PhoneEntry[];
  dnc: boolean;
}

export interface OpportunityRecord {
  id: string;
  leadId: string;
  contactId: string | null;
  valueCents: number;
  currency: string;
  stage: string;
  confidence: number;
  closeDate: string | null;
  ownerId: string;
  status: 'active' | 'won' | 'lost';
  note: string;
}

export interface TaskRecord {
  id: string;
  leadId: string;
  assigneeId: string;
  title: string;
  dueAt: string;
  completedAt: string | null;
}

export interface ActivityRecord {
  id: string;
  leadId: string;
  contactId: string | null;
  userId: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface LeadBundle {
  lead: LeadRecord;
  contacts: ContactRecord[];
  opportunities: OpportunityRecord[];
  tasks: TaskRecord[];
  activities: ActivityRecord[];
}

export interface Dataset {
  leads: LeadRecord[];
  contacts: ContactRecord[];
  opportunities: OpportunityRecord[];
  tasks: TaskRecord[];
  activities: ActivityRecord[];
}

export interface DatasetCounts {
  leads: number;
  contacts: number;
  opportunities: number;
  tasks: number;
  activities: number;
}
