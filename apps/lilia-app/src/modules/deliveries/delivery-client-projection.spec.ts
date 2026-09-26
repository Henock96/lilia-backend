import { DeliveryStatus } from '@prisma/client';

import { projectDeliveryForClient } from './delivery-client-projection';

/**
 * F3-12.0 (H7 / I16) — ce que le client voit de son livreur.
 *
 * Chaque statut a sa ligne, écrite à la main : une table dérivée de la
 * fonction testée ne prouverait que sa cohérence avec elle-même.
 */
describe('projectDeliveryForClient', () => {
  const at = new Date('2026-09-27T10:00:00Z');
  const delivery = (status: DeliveryStatus) => ({
    id: 'd1',
    status,
    lastLatitude: -4.26,
    lastLongitude: 15.24,
    lastPositionAt: at,
    deliverer: {
      id: 'liv-1',
      nom: 'Mabiala Jean-Paul',
      phone: '+242061234567',
      imageUrl: 'https://img/liv.jpg',
    },
  });

  const HIDDEN = {
    lastLatitude: null,
    lastLongitude: null,
    lastPositionAt: null,
    deliverer: { id: 'liv-1', nom: 'Mabiala', phone: null, imageUrl: null },
  };

  it('ASSIGNER → premier mot seulement, ni téléphone, ni photo, ni position', () => {
    expect(projectDeliveryForClient(delivery('ASSIGNER'))).toMatchObject(
      HIDDEN,
    );
  });

  it('ACCEPTER (le livreur va au restaurant) → idem', () => {
    expect(projectDeliveryForClient(delivery('ACCEPTER'))).toMatchObject(
      HIDDEN,
    );
  });

  it('EN_TRANSIT → tout : le client doit pouvoir appeler et suivre', () => {
    expect(projectDeliveryForClient(delivery('EN_TRANSIT'))).toEqual(
      delivery('EN_TRANSIT'),
    );
  });

  it('LIVRER (écran de notation) → premier mot seulement', () => {
    expect(projectDeliveryForClient(delivery('LIVRER'))).toMatchObject(HIDDEN);
  });

  it('ECHEC en course (livreur resté titulaire, F3-05) → premier mot seulement', () => {
    expect(projectDeliveryForClient(delivery('ECHEC'))).toMatchObject(HIDDEN);
  });

  it('EN_ATTENTE sans livreur → deliverer null, position masquée', () => {
    expect(
      projectDeliveryForClient({ ...delivery('EN_ATTENTE'), deliverer: null }),
    ).toMatchObject({ deliverer: null, lastLatitude: null });
  });

  it('les clés restent présentes (le client Flutter les lit une à une)', () => {
    const out = projectDeliveryForClient(delivery('ACCEPTER'));
    expect(Object.keys(out.deliverer!)).toEqual(
      expect.arrayContaining(['id', 'nom', 'phone', 'imageUrl']),
    );
  });

  it('nom vide ou blanc → null plutôt qu’une chaîne vide', () => {
    const out = projectDeliveryForClient({
      ...delivery('ACCEPTER'),
      deliverer: { id: 'x', nom: '   ', phone: '1', imageUrl: null },
    });
    expect(out.deliverer!.nom).toBeNull();
  });

  it('ne modifie pas l’objet reçu', () => {
    const input = delivery('ACCEPTER');
    projectDeliveryForClient(input);
    expect(input.deliverer.phone).toBe('+242061234567');
  });
});
