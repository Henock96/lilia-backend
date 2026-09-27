import { readFileSync } from 'fs';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';

import { BatchPositionsDto } from './tracking-http.dto';

/**
 * F3-12.1, gate R8 — test de CONTRAT avec l'app livreur.
 *
 * `test/contracts/tracking_position_batch.v1.json` est le corps que
 * `lilia_food_delivery` émet réellement (son test
 * `test/contract/tracking_batch_contract_test.dart` compare la requête Dio à
 * ce même fichier). Ici, il passe par le vrai `ValidationPipe`, avec les
 * options de `main.ts`.
 *
 * Le défaut que ce test aurait vu : l'app envoyait `{ positions: [{ latitude,
 * longitude, recordedAt ISO }] }` sans `orderId` — rejeté en 400 à chaque
 * lot, file hors ligne jamais vidée.
 *
 * ⚠️ Deux copies du fixture (une par dépôt) : les modifier ENSEMBLE.
 */
describe('Contrat POST /tracking/position/batch (app livreur ↔ backend)', () => {
  // Mêmes options que le pipe global (`main.ts`).
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: BatchPositionsDto });

  const fixture = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../../../../test/contracts/tracking_position_batch.v1.json',
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;

  it('le corps émis par l’app est accepté, sans qu’aucun champ ne soit retiré', async () => {
    const dto = (await validate(fixture)) as BatchPositionsDto;
    // `whitelist` supprime en silence un champ inconnu : l'égalité prouve
    // qu'aucun champ envoyé n'a été perdu (un renommage le serait).
    expect(JSON.parse(JSON.stringify(dto))).toEqual(fixture);
    expect(dto.positions[0].timestamp).toBe(1790000000000);
  });

  it('l’ancien corps de l’app (sans orderId, latitude, recordedAt ISO) est refusé', async () => {
    await expect(
      validate({
        positions: [
          {
            deliveryId: 'd1',
            latitude: -4.26,
            longitude: 15.24,
            recordedAt: '2026-09-28T10:00:00.000Z',
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('un horodatage ISO est refusé : le contrat est en millisecondes epoch', async () => {
    const positions = (fixture.positions as Record<string, unknown>[]).map(
      (p) => ({ ...p, timestamp: '2026-09-28T10:00:00.000Z' }),
    );
    await expect(validate({ ...fixture, positions })).rejects.toThrow();
  });
});
