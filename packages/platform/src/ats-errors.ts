export class AtsRevisionConflictError extends Error {
  constructor() {
    super('Application was updated by another reviewer');
    this.name = 'AtsRevisionConflictError';
  }
}

export class AtsApplicationNotFoundError extends Error {
  constructor() {
    super('Application not found');
    this.name = 'AtsApplicationNotFoundError';
  }
}

export class AtsMissingSenderError extends Error {
  constructor() { super('Imported message has no sender address'); this.name = 'AtsMissingSenderError'; }
}
