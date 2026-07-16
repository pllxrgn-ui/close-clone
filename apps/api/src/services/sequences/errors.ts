/**
 * Typed errors for the sequence engine (task 2e). Engine-layer rails throw these;
 * the route maps them mechanically to the C8 envelope (CONTRACTS §C8). Keeping the
 * error taxonomy here (not in the route) is what makes the rails impossible to
 * bypass via the API — the API has no path to a send that skips the engine.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export class SequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceError';
  }
}

export class SequenceNotFoundError extends SequenceError {
  readonly sequenceId: string;
  constructor(sequenceId: string) {
    super(`sequence ${sequenceId} not found`);
    this.name = 'SequenceNotFoundError';
    this.sequenceId = sequenceId;
  }
}

export class SequenceValidationError extends SequenceError {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceValidationError';
  }
}

export class EnrollmentLeadNotFoundError extends SequenceError {
  readonly leadId: string;
  constructor(leadId: string) {
    super(`lead ${leadId} not found or soft-deleted`);
    this.name = 'EnrollmentLeadNotFoundError';
    this.leadId = leadId;
  }
}

export class EnrollmentContactNotFoundError extends SequenceError {
  readonly contactId: string;
  constructor(contactId: string) {
    super(`contact ${contactId} not found or soft-deleted`);
    this.name = 'EnrollmentContactNotFoundError';
    this.contactId = contactId;
  }
}

/** A live enrollment for (sequence, contact) already exists (C1 partial-unique). */
export class AlreadyEnrolledError extends SequenceError {
  readonly sequenceId: string;
  readonly contactId: string;
  constructor(sequenceId: string, contactId: string) {
    super(`contact ${contactId} is already enrolled in sequence ${sequenceId}`);
    this.name = 'AlreadyEnrolledError';
    this.sequenceId = sequenceId;
    this.contactId = contactId;
  }
}

export class EnrollmentNotFoundError extends SequenceError {
  readonly enrollmentId: string;
  constructor(enrollmentId: string) {
    super(`enrollment ${enrollmentId} not found`);
    this.name = 'EnrollmentNotFoundError';
    this.enrollmentId = enrollmentId;
  }
}
