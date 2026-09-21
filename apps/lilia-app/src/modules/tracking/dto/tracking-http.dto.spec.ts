// Les décorateurs de validation lisent leurs métadonnées au chargement du DTO.
// Nest l'importe dans son bootstrap ; ici, la suite est montée sans Nest.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { BatchPositionsDto, PositionDto } from './tracking-http.dto';

/**
 * Validation des deux routes HTTP de tracking.
 *
 * ## Pourquoi ce fichier existe
 *
 * `POST /tracking/position` et `/position/batch` déclaraient leur corps par un
 * **type TypeScript inline** :
 *
 * ```ts
 * @Body() body: { orderId: string; lat: number; lng: number; accuracy?: number }
 * ```
 *
 * Un type n'existe pas au runtime : le `ValidationPipe` global n'avait donc
 * rien à valider et laissait passer n'importe quoi jusqu'à `GEOADD` Redis, au
 * calcul de l'ETA et à la colonne `DeliveryLocation.latitude`.
 *
 * C'est exactement le défaut que `payment.service.ts` documente comme « fix H1 »
 * (« ⚠️ Ne PAS retyper la route sur une interface : une interface n'existe pas
 * au runtime, donc le ValidationPipe global ne valide rien »). Le correctif
 * n'avait jamais été propagé ici — alors que le DTO validé existait déjà, câblé
 * sur la seule voie WebSocket (`DriverPositionDto`).
 */
describe('DTO HTTP de tracking', () => {
  const errorsOn = (cls: new () => object, payload: unknown): string[] => {
    const instance = plainToInstance(cls, payload, {
      enableImplicitConversion: true,
    });
    return validateSync(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: false,
    }).flatMap((e) => [
      e.property,
      ...(e.children ?? []).flatMap((c) =>
        (c.children ?? []).map((g) => g.property),
      ),
    ]);
  };

  describe('PositionDto', () => {
    it('accepte une position de Brazzaville', () => {
      expect(
        errorsOn(PositionDto, {
          orderId: 'o1',
          lat: -4.2634,
          lng: 15.2429,
          accuracy: 12,
        }),
      ).toEqual([]);
    });

    it.each([
      ['latitude non numérique', { orderId: 'o1', lat: 'abc', lng: 15.2 }],
      ['latitude hors bornes', { orderId: 'o1', lat: 999, lng: 15.2 }],
      ['longitude hors bornes', { orderId: 'o1', lat: -4.2, lng: 999 }],
      ['orderId absent', { lat: -4.2, lng: 15.2 }],
      ['orderId vide', { orderId: '', lat: -4.2, lng: 15.2 }],
      [
        'précision absurde',
        { orderId: 'o1', lat: -4.2, lng: 15.2, accuracy: 99999 },
      ],
      [
        'précision négative',
        { orderId: 'o1', lat: -4.2, lng: 15.2, accuracy: -1 },
      ],
    ])('refuse : %s', (_label, payload) => {
      expect(errorsOn(PositionDto, payload).length).toBeGreaterThan(0);
    });
  });

  describe('BatchPositionsDto', () => {
    const point = { lat: -4.2634, lng: 15.2429, timestamp: 1758000000000 };

    it('accepte un lot de positions', () => {
      expect(
        errorsOn(BatchPositionsDto, { orderId: 'o1', positions: [point] }),
      ).toEqual([]);
    });

    it('refuse un lot vide — il n’y a rien à synchroniser', () => {
      expect(
        errorsOn(BatchPositionsDto, { orderId: 'o1', positions: [] }),
      ).toContain('positions');
    });

    it('refuse un lot démesuré', () => {
      // Le livreur accumule hors ligne : quelques centaines de points au plus.
      // Sans borne, un corps de plusieurs mégaoctets était accepté et parsé.
      expect(
        errorsOn(BatchPositionsDto, {
          orderId: 'o1',
          positions: Array.from({ length: 5000 }, () => point),
        }),
      ).toContain('positions');
    });

    it('valide CHAQUE point du lot, pas seulement le premier', () => {
      // Seul le dernier point est réellement utilisé par le contrôleur : une
      // validation qui ne regarderait que le premier laisserait passer
      // exactement la valeur qui atteint Redis et la base.
      const errors = errorsOn(BatchPositionsDto, {
        orderId: 'o1',
        positions: [point, { lat: 999, lng: 15.2, timestamp: 1 }],
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
