import { z } from 'zod';

/**
 * Domain DTOs (CONTRACTS §C1) — API-shape zod schemas with inferred TS types.
 *
 * These are the JSON, camelCase shapes exchanged over REST (CONTRACTS §C7),
 * NOT the Drizzle row shapes. The Drizzle schema (`apps/api/src/db/schema.ts`)
 * is the persistence shape; these are the contract the API speaks. The enum
 * value arrays below are the single source of truth for every string-union in
 * the system — the Drizzle schema imports them so column enums and DTO enums can
 * never drift.
 *
 * Zod schema = runtime contract; the exported TS type is derived, never
 * hand-written separately (CONTRACTS §intro).
 */

// --- Enum value arrays (single source of truth) ----------------------------

export const userRoleValues = ['rep', 'admin'] as const;
export const opportunityStatusValues = ['active', 'won', 'lost'] as const;
export const customFieldEntityValues = ['lead', 'contact', 'opportunity'] as const;
export const customFieldTypeValues = ['text', 'number', 'date', 'select', 'user'] as const;
export const noteStatusValues = ['draft', 'final'] as const;
export const emailProviderValues = ['gmail', 'mock'] as const;
export const syncStatusValues = [
  'UNLINKED',
  'AUTHORIZING',
  'BACKFILLING',
  'LIVE',
  'DEGRADED',
  'RESYNC',
  'REAUTH_REQUIRED',
] as const;
export const emailDirectionValues = ['in', 'out'] as const;
export const threadTriageValues = ['matched', 'ambiguous', 'ignored'] as const;
export const sequenceStatusValues = ['active', 'archived'] as const;
export const sequenceStepTypeValues = ['email', 'call_task', 'sms'] as const;
export const sequenceEnrollmentStateValues = [
  'active',
  'paused',
  'finished',
  'unenrolled',
] as const;
export const sendIntentStateValues = [
  'SCHEDULED',
  'CLAIMED',
  'SENT',
  'SKIPPED',
  'BLOCKED',
  'FAILED',
  'FAILED_TIMEOUT',
  'AWAITING_REVIEW',
] as const;
export const suppressionKindValues = ['email', 'phone'] as const;
export const suppressionSourceValues = [
  'unsubscribe',
  'bounce',
  'stop_keyword',
  'manual',
  'import',
] as const;
export const templateChannelValues = ['email', 'sms'] as const;
export const callDirectionValues = ['inbound', 'outbound'] as const;
export const callStatusValues = [
  'queued',
  'ringing',
  'answered',
  'completed',
  'failed',
  'voicemail',
  'missed',
] as const;
export const smsDirectionValues = ['inbound', 'outbound'] as const;
export const webhookProviderValues = ['twilio', 'gmail'] as const;
export const webhookDeliveryStateValues = ['pending', 'delivered', 'failed'] as const;
export const auditActorTypeValues = ['user', 'system', 'api_token'] as const;

// --- Enum schemas ----------------------------------------------------------

export const userRoleSchema = z.enum(userRoleValues);
export const opportunityStatusSchema = z.enum(opportunityStatusValues);
export const customFieldEntitySchema = z.enum(customFieldEntityValues);
export const customFieldTypeSchema = z.enum(customFieldTypeValues);
export const noteStatusSchema = z.enum(noteStatusValues);
export const emailProviderSchema = z.enum(emailProviderValues);
export const syncStatusSchema = z.enum(syncStatusValues);
export const emailDirectionSchema = z.enum(emailDirectionValues);
export const threadTriageSchema = z.enum(threadTriageValues);
export const sequenceStatusSchema = z.enum(sequenceStatusValues);
export const sequenceStepTypeSchema = z.enum(sequenceStepTypeValues);
export const sequenceEnrollmentStateSchema = z.enum(sequenceEnrollmentStateValues);
export const sendIntentStateSchema = z.enum(sendIntentStateValues);
export const suppressionKindSchema = z.enum(suppressionKindValues);
export const suppressionSourceSchema = z.enum(suppressionSourceValues);
export const templateChannelSchema = z.enum(templateChannelValues);
export const callDirectionSchema = z.enum(callDirectionValues);
export const callStatusSchema = z.enum(callStatusValues);
export const smsDirectionSchema = z.enum(smsDirectionValues);
export const webhookProviderSchema = z.enum(webhookProviderValues);
export const webhookDeliveryStateSchema = z.enum(webhookDeliveryStateValues);
export const auditActorTypeSchema = z.enum(auditActorTypeValues);

// --- Shared primitives -----------------------------------------------------

/** ISO-8601 timestamp string (API JSON carries timestamps as strings). */
const isoTimestamp = z.string();
/** ISO-8601 date (YYYY-MM-DD). */
const isoDate = z.string();
const uuid = z.string().uuid();

export const emailEntrySchema = z.object({
  email: z.string(),
  type: z.string(),
});
export type EmailEntry = z.infer<typeof emailEntrySchema>;

export const phoneEntrySchema = z.object({
  phone: z.string(),
  type: z.string(),
});
export type PhoneEntry = z.infer<typeof phoneEntrySchema>;

// --- Entity DTOs (CONTRACTS §C1) -------------------------------------------

export const userSchema = z.object({
  id: uuid,
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  idpSubject: z.string(),
  isActive: z.boolean(),
  timezone: z.string(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type User = z.infer<typeof userSchema>;

export const leadStatusSchema = z.object({
  id: uuid,
  label: z.string(),
  sortOrder: z.number().int(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const opportunityStageSchema = z.object({
  id: uuid,
  label: z.string(),
  sortOrder: z.number().int(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type OpportunityStage = z.infer<typeof opportunityStageSchema>;

export const leadSchema = z.object({
  id: uuid,
  name: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  statusId: uuid.nullable(),
  ownerId: uuid.nullable(),
  custom: z.record(z.unknown()),
  lastContactedAt: isoTimestamp.nullable(),
  lastInboundAt: isoTimestamp.nullable(),
  nextTaskDueAt: isoTimestamp.nullable(),
  lastCallAt: isoTimestamp.nullable(),
  lastEmailAt: isoTimestamp.nullable(),
  lastSmsAt: isoTimestamp.nullable(),
  dnc: z.boolean(),
  deletedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Lead = z.infer<typeof leadSchema>;

export const contactSchema = z.object({
  id: uuid,
  leadId: uuid,
  name: z.string(),
  title: z.string().nullable(),
  emails: z.array(emailEntrySchema),
  phones: z.array(phoneEntrySchema),
  dnc: z.boolean(),
  deletedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Contact = z.infer<typeof contactSchema>;

export const opportunitySchema = z.object({
  id: uuid,
  leadId: uuid,
  contactId: uuid.nullable(),
  valueCents: z.number().int(),
  currency: z.string().length(3),
  stageId: uuid.nullable(),
  confidence: z.number().int().min(0).max(100),
  closeDate: isoDate.nullable(),
  ownerId: uuid.nullable(),
  status: opportunityStatusSchema,
  note: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Opportunity = z.infer<typeof opportunitySchema>;

export const customFieldDefSchema = z.object({
  id: uuid,
  entity: customFieldEntitySchema,
  key: z.string(),
  label: z.string(),
  type: customFieldTypeSchema,
  options: z.array(z.unknown()).nullable(),
  required: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

export const activitySchema = z.object({
  id: uuid,
  leadId: uuid,
  contactId: uuid.nullable(),
  userId: uuid.nullable(),
  type: z.string(),
  occurredAt: isoTimestamp,
  payload: z.record(z.unknown()),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Activity = z.infer<typeof activitySchema>;

export const taskSchema = z.object({
  id: uuid,
  leadId: uuid,
  assigneeId: uuid.nullable(),
  title: z.string(),
  dueAt: isoTimestamp.nullable(),
  completedAt: isoTimestamp.nullable(),
  createdBy: uuid.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Task = z.infer<typeof taskSchema>;

export const noteSchema = z.object({
  id: uuid,
  leadId: uuid,
  authorId: uuid.nullable(),
  bodyMd: z.string(),
  status: noteStatusSchema,
  aiGenerated: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Note = z.infer<typeof noteSchema>;

export const emailAccountSchema = z.object({
  id: uuid,
  userId: uuid,
  address: z.string(),
  provider: emailProviderSchema,
  syncStatus: syncStatusSchema,
  historyCursor: z.string().nullable(),
  backfillCheckpoint: z.record(z.unknown()).nullable(),
  dailySendCount: z.number().int(),
  dailyCountDate: isoDate.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type EmailAccount = z.infer<typeof emailAccountSchema>;

export const emailThreadSchema = z.object({
  id: uuid,
  leadId: uuid.nullable(),
  subjectNorm: z.string().nullable(),
  participants: z.array(z.unknown()),
  triageStatus: threadTriageSchema,
  providerThreadId: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type EmailThread = z.infer<typeof emailThreadSchema>;

export const emailMessageSchema = z.object({
  id: uuid,
  accountId: uuid,
  providerMessageId: z.string().nullable(),
  rfcMessageId: z.string().nullable(),
  threadId: uuid.nullable(),
  direction: emailDirectionSchema,
  fromAddr: z.string().nullable(),
  toAddrs: z.array(z.unknown()),
  cc: z.array(z.unknown()),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  bodyRef: z.string().nullable(),
  sentAt: isoTimestamp.nullable(),
  inReplyTo: z.string().nullable(),
  refs: z.array(z.unknown()),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;

export const sequenceSchema = z.object({
  id: uuid,
  name: z.string(),
  status: sequenceStatusSchema,
  settings: z.record(z.unknown()),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Sequence = z.infer<typeof sequenceSchema>;

export const sequenceStepSchema = z.object({
  id: uuid,
  sequenceId: uuid,
  sortOrder: z.number().int(),
  type: sequenceStepTypeSchema,
  delayHours: z.number().int(),
  templateId: uuid.nullable(),
  requiresReview: z.boolean(),
  condition: z.record(z.unknown()).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SequenceStep = z.infer<typeof sequenceStepSchema>;

export const sequenceEnrollmentSchema = z.object({
  id: uuid,
  sequenceId: uuid,
  leadId: uuid,
  contactId: uuid,
  emailAccountId: uuid.nullable(),
  enrolledBy: uuid.nullable(),
  state: sequenceEnrollmentStateSchema,
  pausedReason: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SequenceEnrollment = z.infer<typeof sequenceEnrollmentSchema>;

export const sendIntentSchema = z.object({
  id: uuid,
  enrollmentId: uuid,
  stepId: uuid,
  channel: sequenceStepTypeSchema,
  dueAt: isoTimestamp,
  state: sendIntentStateSchema,
  claimedAt: isoTimestamp.nullable(),
  workerId: z.string().nullable(),
  sentAt: isoTimestamp.nullable(),
  providerMessageId: z.string().nullable(),
  skipReason: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SendIntent = z.infer<typeof sendIntentSchema>;

export const suppressionSchema = z.object({
  id: uuid,
  kind: suppressionKindSchema,
  value: z.string(),
  source: suppressionSourceSchema,
  reason: z.string().nullable(),
  createdBy: uuid.nullable(),
  releasedAt: isoTimestamp.nullable(),
  releasedBy: uuid.nullable(),
  releaseReason: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Suppression = z.infer<typeof suppressionSchema>;

export const templateSchema = z.object({
  id: uuid,
  name: z.string(),
  channel: templateChannelSchema,
  subject: z.string().nullable(),
  body: z.string(),
  ownerId: uuid.nullable(),
  shared: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Template = z.infer<typeof templateSchema>;

export const snippetSchema = z.object({
  id: uuid,
  shortcut: z.string(),
  body: z.string(),
  ownerId: uuid.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Snippet = z.infer<typeof snippetSchema>;

export const callSchema = z.object({
  id: uuid,
  leadId: uuid,
  contactId: uuid.nullable(),
  userId: uuid.nullable(),
  direction: callDirectionSchema,
  twilioSid: z.string().nullable(),
  status: callStatusSchema,
  durationS: z.number().int().nullable(),
  outcome: z.string().nullable(),
  recordingRef: z.string().nullable(),
  transcriptRef: z.string().nullable(),
  startedAt: isoTimestamp.nullable(),
  endedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Call = z.infer<typeof callSchema>;

export const smsMessageSchema = z.object({
  id: uuid,
  leadId: uuid,
  contactId: uuid.nullable(),
  userId: uuid.nullable(),
  direction: smsDirectionSchema,
  fromNumber: z.string(),
  toNumber: z.string(),
  body: z.string(),
  providerSid: z.string().nullable(),
  status: z.string(),
  sentAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SmsMessage = z.infer<typeof smsMessageSchema>;

export const smartViewSchema = z.object({
  id: uuid,
  name: z.string(),
  ownerId: uuid.nullable(),
  shared: z.boolean(),
  dsl: z.string(),
  ast: z.record(z.unknown()),
  sort: z.record(z.unknown()).nullable(),
  columns: z.array(z.unknown()).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SmartView = z.infer<typeof smartViewSchema>;

export const webhookInboxSchema = z.object({
  id: uuid,
  provider: webhookProviderSchema,
  providerEventId: z.string(),
  raw: z.record(z.unknown()),
  receivedAt: isoTimestamp,
  processedAt: isoTimestamp.nullable(),
  error: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WebhookInbox = z.infer<typeof webhookInboxSchema>;

export const webhookSubscriptionSchema = z.object({
  id: uuid,
  url: z.string(),
  secret: z.string(),
  events: z.array(z.unknown()),
  isActive: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

export const webhookDeliverySchema = z.object({
  id: uuid,
  subscriptionId: uuid,
  event: z.record(z.unknown()),
  state: webhookDeliveryStateSchema,
  attempts: z.number().int(),
  nextRetryAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const apiTokenSchema = z.object({
  id: uuid,
  name: z.string(),
  hash: z.string(),
  scopes: z.array(z.unknown()),
  createdBy: uuid.nullable(),
  lastUsedAt: isoTimestamp.nullable(),
  revokedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const auditLogSchema = z.object({
  id: uuid,
  actorId: uuid.nullable(),
  actorType: auditActorTypeSchema,
  action: z.string(),
  entity: z.string(),
  entityId: uuid.nullable(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  at: isoTimestamp,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const orgSettingsSchema = z.object({
  id: uuid,
  recordingEnabled: z.boolean(),
  recordingEnabledBy: uuid.nullable(),
  recordingLegalSignoffRef: z.string().nullable(),
  quietHours: z.record(z.unknown()).nullable(),
  sendingWindow: z.record(z.unknown()).nullable(),
  dailySendCap: z.number().int(),
  companyTimezone: z.string(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export const syncEventSchema = z.object({
  id: uuid,
  accountId: uuid,
  fromState: syncStatusSchema.nullable(),
  toState: syncStatusSchema,
  cause: z.string(),
  at: isoTimestamp,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SyncEvent = z.infer<typeof syncEventSchema>;
