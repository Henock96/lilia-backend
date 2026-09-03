import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { DeliveryDestinationService } from './delivery-destination.service';

/**
 * Le défaut que ce service corrige : la destination d'une commande était le
 * GPS du téléphone au moment de payer. Ces tests vérifient qu'elle vient
 * désormais de l'adresse, et **uniquement** d'elle.
 */
describe('DeliveryDestinationService', () => {
  const prisma = { adresses: { findUnique: jest.fn() } };
  let service: DeliveryDestinationService;

  const POTO_POTO = { latitude: -4.274029, longitude: 15.267756 };
  const BACONGO = { latitude: -4.295585, longitude: 15.245811 };

  const adresse = (overrides: Record<string, unknown> = {}) => ({
    id: 'adr-1',
    userId: 'u1',
    rue: '15 Avenue de la Paix',
    ville: 'Brazzaville',
    country: 'Congo',
    latitude: null,
    longitude: null,
    locationPrecision: 'UNKNOWN',
    landmark: null,
    quartierId: null,
    quartier: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeliveryDestinationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(DeliveryDestinationService);
  });

  // ── Propriété ──────────────────────────────────────────────────────────
  it('refuse une adresse inexistante', async () => {
    prisma.adresses.findUnique.mockResolvedValue(null);
    await expect(service.resolveForAddress('adr-1', 'u1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it("refuse l'adresse d'un autre utilisateur", async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({ userId: 'quelquun-dautre' }),
    );
    await expect(service.resolveForAddress('adr-1', 'u1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  // ── Niveau 1 : position posée par le client ────────────────────────────
  it('utilise la position de l’adresse quand elle existe → EXACT', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({ ...POTO_POTO, locationPrecision: 'EXACT' }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.latitude).toBe(POTO_POTO.latitude);
    expect(result.longitude).toBe(POTO_POTO.longitude);
    expect(result.precision).toBe('EXACT');
  });

  /**
   * Le test qui porte tout le chantier : le client est à Bacongo, son adresse
   * est à Poto-Poto. La destination doit être Poto-Poto.
   */
  it('ignore la position du téléphone du client', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({ ...POTO_POTO, locationPrecision: 'EXACT' }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1', {
      latitude: BACONGO.latitude,
      longitude: BACONGO.longitude,
    });

    expect(result.latitude).toBe(POTO_POTO.latitude);
    expect(result.longitude).toBe(POTO_POTO.longitude);
    expect(result.latitude).not.toBe(BACONGO.latitude);
  });

  // ── Niveau 2 : centroïde du quartier ───────────────────────────────────
  it('retombe sur le centroïde du quartier → APPROXIMATE', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({
        quartierId: 'q1',
        quartier: { id: 'q1', nom: 'Poto-Poto', ...POTO_POTO },
      }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.precision).toBe('APPROXIMATE');
    expect(result.latitude).toBe(POTO_POTO.latitude);
    expect(result.quartierNom).toBe('Poto-Poto');
  });

  it('ne promeut pas un centroïde déjà enregistré en EXACT', async () => {
    // Une adresse dont la position vient d'un centroïde garde sa qualification
    // même si les coordonnées sont, elles, bien présentes.
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({ ...POTO_POTO, locationPrecision: 'APPROXIMATE' }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');
    expect(result.precision).toBe('APPROXIMATE');
  });

  // ── Niveau 3 : rien ────────────────────────────────────────────────────
  it('rend UNKNOWN sans coordonnées plutôt qu’un point inventé', async () => {
    prisma.adresses.findUnique.mockResolvedValue(adresse());

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.precision).toBe('UNKNOWN');
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
  });

  it('ne retombe JAMAIS sur le centre de Brazzaville', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({
        quartierId: 'q1',
        quartier: { id: 'q1', nom: 'Djiri', latitude: null, longitude: null },
      }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.latitude).toBeNull();
    // -4.2634 / 15.2429 était le repli codé en dur dans les trois apps.
    expect(result.latitude).not.toBe(-4.2634);
  });

  // ── Robustesse sur les données existantes ──────────────────────────────
  it('descend d’un cran si l’adresse porte des coordonnées aberrantes', async () => {
    // Ligne écrite avant l'introduction des contrôles : (0, 0).
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({
        latitude: 0,
        longitude: 0,
        locationPrecision: 'EXACT',
        quartierId: 'q1',
        quartier: { id: 'q1', nom: 'Poto-Poto', ...POTO_POTO },
      }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.precision).toBe('APPROXIMATE');
    expect(result.latitude).toBe(POTO_POTO.latitude);
  });

  it('ignore un centroïde de quartier aberrant', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({
        quartierId: 'q1',
        quartier: {
          id: 'q1',
          nom: 'Poto-Poto',
          latitude: 48.85,
          longitude: 2.35,
        },
      }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');
    expect(result.precision).toBe('UNKNOWN');
    expect(result.latitude).toBeNull();
  });

  // ── Texte destiné au livreur ───────────────────────────────────────────
  it('inclut le quartier dans l’adresse lisible et laisse tomber « Congo »', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({
        quartierId: 'q1',
        quartier: { id: 'q1', nom: 'Poto-Poto', ...POTO_POTO },
      }),
    );

    const result = await service.resolveForAddress('adr-1', 'u1');

    expect(result.address).toBe('15 Avenue de la Paix, Poto-Poto, Brazzaville');
    expect(result.address).not.toContain('Congo');
  });

  it('reste lisible sans quartier', async () => {
    prisma.adresses.findUnique.mockResolvedValue(adresse());
    const result = await service.resolveForAddress('adr-1', 'u1');
    expect(result.address).toBe('15 Avenue de la Paix, Brazzaville');
  });

  it('recopie les repères pour le livreur', async () => {
    prisma.adresses.findUnique.mockResolvedValue(
      adresse({ landmark: 'Portail bleu face à la pharmacie' }),
    );
    const result = await service.resolveForAddress('adr-1', 'u1');
    expect(result.landmark).toBe('Portail bleu face à la pharmacie');
  });

  // ── Observabilité ──────────────────────────────────────────────────────
  //
  // Une dégradation muette ne se voit pas : c'est ce qui a laissé 12 quartiers
  // sans centroïde sans que personne le mesure. Les codes sont donc vérifiés
  // ici comme n'importe quel comportement.
  describe('journalisation', () => {
    let warn: jest.SpyInstance;
    let log: jest.SpyInstance;

    beforeEach(() => {
      warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);
      log = jest
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
      log.mockRestore();
    });

    it('signale DESTINATION_UNKNOWN quand aucun repli ne tient', async () => {
      prisma.adresses.findUnique.mockResolvedValue(adresse());
      await service.resolveForAddress('adr-1', 'u1');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('DESTINATION_UNKNOWN'),
      );
    });

    it('signale DESTINATION_APPROXIMATE sur repli au centroïde', async () => {
      prisma.adresses.findUnique.mockResolvedValue(
        adresse({
          quartierId: 'q1',
          quartier: { id: 'q1', nom: 'Poto-Poto', ...POTO_POTO },
        }),
      );
      await service.resolveForAddress('adr-1', 'u1');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('DESTINATION_APPROXIMATE'),
      );
    });

    it('signale INVALID_COORDINATES sur une position aberrante en base', async () => {
      prisma.adresses.findUnique.mockResolvedValue(
        // Paris : hors du Congo, donc rejetée par le contrôle.
        adresse({ latitude: 48.8566, longitude: 2.3522 }),
      );
      await service.resolveForAddress('adr-1', 'u1');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('INVALID_COORDINATES'),
      );
    });

    it('ne crie pas INVALID_COORDINATES sur une position déjà qualifiée APPROXIMATE', async () => {
      prisma.adresses.findUnique.mockResolvedValue(
        adresse({ ...BACONGO, locationPrecision: 'APPROXIMATE' }),
      );
      await service.resolveForAddress('adr-1', 'u1');
      expect(warn).not.toHaveBeenCalled();
    });

    it("n'écrit aucune coordonnée dans les logs", async () => {
      prisma.adresses.findUnique.mockResolvedValue(
        adresse({ latitude: 48.8566, longitude: 2.3522 }),
      );
      await service.resolveForAddress('adr-1', 'u1');
      const written = [...warn.mock.calls, ...log.mock.calls].flat().join(' ');
      expect(written).not.toContain('48.8566');
      expect(written).not.toContain('2.3522');
    });
  });
});
