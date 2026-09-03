import { PrismaPg } from '@prisma/adapter-pg';
import { LocationPrecision, PrismaClient } from '@prisma/client';

import { DeliveryDestinationService } from '../../apps/lilia-app/src/modules/orders/delivery-destination.service';
import { PrismaService } from '../../apps/lilia-app/src/prisma/prisma.service';

/**
 * La résolution de destination, sur un vrai PostgreSQL.
 *
 * Les tests unitaires du service mockent Prisma : ils prouvent que la logique
 * de repli est juste, jamais que les colonnes existent, que l'enum accepte les
 * trois valeurs, ni que les données écrites se relisent identiques. C'est
 * précisément ce qui manquait avant : le défaut d'origine n'était pas une
 * mauvaise logique, c'était un **modèle de données** incapable de porter la
 * position d'une adresse.
 *
 * Se saute proprement sans `TEST_DATABASE_URL`.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('Destination de livraison — résolution sur base réelle', () => {
  let prisma: PrismaClient;
  let service: DeliveryDestinationService;

  const suffix = Date.now().toString(36);
  const ids = {
    user: `dest-user-${suffix}`,
    other: `dest-other-${suffix}`,
    quartierSitue: `dest-q-ok-${suffix}`,
    quartierSansCentroide: `dest-q-nul-${suffix}`,
  };

  // Poto-Poto, vérifié par géocodage le 01/09/2026.
  const POTO_POTO = { latitude: -4.274029, longitude: 15.267756 };
  // Bacongo : la position « du téléphone » dans les scénarios de divergence.
  const BACONGO = { latitude: -4.295585, longitude: 15.245811 };

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
    await prisma.$connect();
    service = new DeliveryDestinationService(
      prisma as unknown as PrismaService,
    );

    await prisma.user.createMany({
      data: [
        {
          id: ids.user,
          firebaseUid: `fb-${ids.user}`,
          email: `${ids.user}@test.local`,
          role: 'CLIENT',
        },
        {
          id: ids.other,
          firebaseUid: `fb-${ids.other}`,
          email: `${ids.other}@test.local`,
          role: 'CLIENT',
        },
      ],
      skipDuplicates: true,
    });

    await prisma.quartier.createMany({
      data: [
        {
          id: ids.quartierSitue,
          nom: `Poto-Poto ${suffix}`,
          ville: 'Brazzaville',
          ...POTO_POTO,
        },
        {
          id: ids.quartierSansCentroide,
          nom: `Djiri ${suffix}`,
          ville: 'Brazzaville',
        },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.adresses.deleteMany({
      where: { userId: { in: [ids.user, ids.other] } },
    });
    await prisma.quartier.deleteMany({
      where: { id: { in: [ids.quartierSitue, ids.quartierSansCentroide] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [ids.user, ids.other] } },
    });
    await prisma.$disconnect();
  });

  async function createAdresse(data: Record<string, unknown>) {
    return prisma.adresses.create({
      data: {
        rue: 'Rue Bayonne',
        ville: 'Brazzaville',
        country: 'Congo',
        userId: ids.user,
        ...data,
      },
    });
  }

  it('écrit et relit une position exacte sans perte de précision', async () => {
    const adresse = await createAdresse({
      ...POTO_POTO,
      locationPrecision: LocationPrecision.EXACT,
      landmark: 'Portail bleu face à la pharmacie',
      label: 'Maison',
    });

    const resolved = await service.resolveForAddress(adresse.id, ids.user);

    // `DOUBLE PRECISION` : les six décimales survivent à l'aller-retour, ce
    // qui vaut environ 10 cm. Un `REAL` en aurait perdu la moitié.
    expect(resolved.latitude).toBe(POTO_POTO.latitude);
    expect(resolved.longitude).toBe(POTO_POTO.longitude);
    expect(resolved.precision).toBe(LocationPrecision.EXACT);
    expect(resolved.landmark).toBe('Portail bleu face à la pharmacie');
  });

  it('retombe sur le centroïde du quartier → APPROXIMATE', async () => {
    const adresse = await createAdresse({ quartierId: ids.quartierSitue });

    const resolved = await service.resolveForAddress(adresse.id, ids.user);

    expect(resolved.precision).toBe(LocationPrecision.APPROXIMATE);
    expect(resolved.latitude).toBe(POTO_POTO.latitude);
    expect(resolved.quartierId).toBe(ids.quartierSitue);
  });

  it('rend UNKNOWN sans coordonnées quand le quartier n’a pas de centroïde', async () => {
    const adresse = await createAdresse({
      quartierId: ids.quartierSansCentroide,
    });

    const resolved = await service.resolveForAddress(adresse.id, ids.user);

    expect(resolved.precision).toBe(LocationPrecision.UNKNOWN);
    expect(resolved.latitude).toBeNull();
    expect(resolved.longitude).toBeNull();
  });

  it('ne retombe jamais sur le centre de Brazzaville', async () => {
    const adresse = await createAdresse({});
    const resolved = await service.resolveForAddress(adresse.id, ids.user);
    expect(resolved.latitude).not.toBe(-4.2634);
    expect(resolved.latitude).toBeNull();
  });

  /**
   * Le scénario qui motive tout le chantier : le client commande depuis son
   * bureau (Bacongo) une livraison à son domicile (Poto-Poto).
   */
  it('ignore la position du téléphone, même à 3 km de la destination', async () => {
    const adresse = await createAdresse({
      ...POTO_POTO,
      locationPrecision: LocationPrecision.EXACT,
    });

    const resolved = await service.resolveForAddress(adresse.id, ids.user, {
      latitude: BACONGO.latitude,
      longitude: BACONGO.longitude,
    });

    expect(resolved.latitude).toBe(POTO_POTO.latitude);
    expect(resolved.longitude).toBe(POTO_POTO.longitude);
  });

  it('refuse l’adresse d’un autre utilisateur', async () => {
    const adresse = await prisma.adresses.create({
      data: {
        rue: 'Rue voisine',
        ville: 'Brazzaville',
        country: 'Congo',
        userId: ids.other,
      },
    });

    await expect(
      service.resolveForAddress(adresse.id, ids.user),
    ).rejects.toThrow(/appartient/i);
  });

  it('ignore des coordonnées aberrantes déjà en base et descend d’un cran', async () => {
    // Simule une ligne écrite avant l'introduction des contrôles.
    const adresse = await createAdresse({
      latitude: 0,
      longitude: 0,
      locationPrecision: LocationPrecision.EXACT,
      quartierId: ids.quartierSitue,
    });

    const resolved = await service.resolveForAddress(adresse.id, ids.user);

    expect(resolved.precision).toBe(LocationPrecision.APPROXIMATE);
    expect(resolved.latitude).toBe(POTO_POTO.latitude);
  });

  it('inclut le quartier dans l’adresse lisible par le livreur', async () => {
    const adresse = await createAdresse({ quartierId: ids.quartierSitue });
    const resolved = await service.resolveForAddress(adresse.id, ids.user);

    expect(resolved.address).toContain('Rue Bayonne');
    expect(resolved.address).toContain(`Poto-Poto ${suffix}`);
    expect(resolved.address).toContain('Brazzaville');
    // « Congo » a disparu : toutes les livraisons y sont, l'information ne
    // situait rien et allongeait la ligne affichée au livreur.
    expect(resolved.address).not.toContain('Congo');
  });

  it('la destination d’une commande est un instantané, pas une jointure', async () => {
    const adresse = await createAdresse({
      ...POTO_POTO,
      locationPrecision: LocationPrecision.EXACT,
    });
    const figee = await service.resolveForAddress(adresse.id, ids.user);

    // Le client corrige son adresse le lendemain.
    await prisma.adresses.update({
      where: { id: adresse.id },
      data: { ...BACONGO },
    });

    const nouvelle = await service.resolveForAddress(adresse.id, ids.user);

    // Une commande passée hier garderait `figee` : c'est `Order` qui porte le
    // snapshot, le résolveur rend toujours l'état courant de l'adresse.
    expect(figee.latitude).toBe(POTO_POTO.latitude);
    expect(nouvelle.latitude).toBe(BACONGO.latitude);
  });
});
