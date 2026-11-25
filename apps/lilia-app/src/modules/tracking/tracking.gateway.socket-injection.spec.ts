import 'reflect-metadata';
import {
  MESSAGE_MAPPING_METADATA,
  PARAM_ARGS_METADATA,
} from '@nestjs/websockets/constants';
import { WsParamtype } from '@nestjs/websockets/enums/ws-paramtype.enum';
import { TrackingGateway } from './tracking.gateway';

/**
 * Suivi du livreur muet depuis le 05/08/2026 (constaté le 23/11 en démo) :
 * `Cannot read properties of undefined (reading 'data')` à chaque
 * `driver:position` et `order:watch`.
 *
 * Dès qu'un paramètre d'un handler WebSocket porte un décorateur
 * (`@MessageBody`), NestJS ne remplit QUE les paramètres décorés : un
 * `client: Socket` sans `@ConnectedSocket()` reçoit `undefined`, et
 * `client.data` plante avant toute logique. Les tests qui appellent les
 * handlers à la main (en passant la socket) ne peuvent pas le voir : celui-ci
 * vérifie le contrat que NestJS applique à l'exécution.
 */
describe('TrackingGateway — injection de la socket', () => {
  const prototype = TrackingGateway.prototype as unknown as Record<
    string,
    unknown
  >;
  const handlers = Object.getOwnPropertyNames(prototype).filter((name) => {
    const fn = prototype[name];
    return (
      typeof fn === 'function' &&
      Reflect.getMetadata(MESSAGE_MAPPING_METADATA, fn) === true
    );
  });

  it('recense les handlers de messages', () => {
    expect(handlers).toEqual(
      expect.arrayContaining([
        'onWatchOrder',
        'onUnwatchOrder',
        'onDriverPosition',
      ]),
    );
  });

  it.each(['onWatchOrder', 'onUnwatchOrder', 'onDriverPosition'])(
    '%s reçoit la socket par @ConnectedSocket() en premier paramètre',
    (name) => {
      const params = (Reflect.getMetadata(
        PARAM_ARGS_METADATA,
        TrackingGateway,
        name,
      ) ?? {}) as Record<string, { index: number }>;
      const socket = Object.entries(params).find(([key]) =>
        key.startsWith(`${WsParamtype.SOCKET}:`),
      );
      expect(socket?.[1].index).toBe(0);
    },
  );
});
