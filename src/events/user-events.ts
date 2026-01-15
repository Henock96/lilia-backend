/* eslint-disable prettier/prettier */
export abstract class BaseOrderEvent {
  constructor(
    public readonly userId: string,
    public readonly nom: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}
export class UserCreatedEvent extends BaseOrderEvent {
  constructor(userId: string, nom: string, timestamp: Date) {
    super(userId, nom, timestamp);
  }
}