/* eslint-disable prettier/prettier */
export abstract class BaseEvent {
  constructor(
    public readonly userId: string,
    public readonly nom: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
export class UserCreatedEvent extends BaseEvent {
  constructor(userId: string, nom: string, timestamp: Date) {
    super(userId, nom, timestamp);
  }
}

// N'etend volontairement pas BaseEvent : seul userId est requis pour ce flux.
export class UserPhoneCompletedEvent {
  constructor(public readonly userId: string) {}
}