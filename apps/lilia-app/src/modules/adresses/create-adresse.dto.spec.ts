import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateAdresseDto } from './dto/create-adresse.dto';
import { UpdateAdresseDto } from './dto/update-adresse.dto';

/**
 * **Le quartier est la seule garantie qu'une commande ait une destination.**
 *
 * `DeliveryDestinationService` résout en trois niveaux : position posée à la
 * main (`EXACT`), centroïde du quartier (`APPROXIMATE`), rien (`UNKNOWN`). Sans
 * quartier, il n'y a pas de niveau 2 : la commande part sans destination, et le
 * livreur n'a qu'un texte libre — dans une ville où le géocodage inverse rend
 * un Plus Code trois fois sur cinq.
 *
 * Mesuré en production le 20/09/2026 : **20 adresses sur 45 sans quartier**,
 * toutes créées entre juillet 2025 et mars 2026. Aucune depuis avril, parce que
 * les deux interfaces l'exigent — **et elles seules**. Ce DTO l'acceptait
 * absent, si bien qu'un ancien binaire ou un appel direct à l'API pouvait
 * continuer d'en créer.
 *
 * Ces tests posent la règle là où rien ne la contourne.
 */
describe('CreateAdresseDto — le quartier est obligatoire', () => {
  const valide = {
    rue: '12 rue Mbochi',
    ville: 'Brazzaville',
    country: 'Congo',
    quartierId: 'q-poto-poto',
  };

  const erreursSur = async (
    payload: Record<string, unknown>,
    champ: string,
  ) => {
    const dto = plainToInstance(CreateAdresseDto, payload);
    const erreurs = await validate(dto);
    return erreurs.filter((e) => e.property === champ);
  };

  it('accepte une adresse complète', async () => {
    expect(await erreursSur(valide, 'quartierId')).toHaveLength(0);
  });

  it.each([
    // ⚠️ `absent` retire vraiment la clé. Une première version écrivait
    // `['absent', {}]` puis étalait `{ ...valide, ...surcharge }` — ce qui
    // laissait le quartier valide en place et faisait passer le test pour une
    // raison qui n'avait rien à voir avec ce qu'il prétendait vérifier.
    ['absent', { quartierId: undefined }],
    ['null', { quartierId: null }],
    ['chaîne vide', { quartierId: '' }],
    ['espaces seuls', { quartierId: '   ' }],
  ])('refuse un quartier %s', async (_cas, surcharge) => {
    const payload: Record<string, unknown> = { ...valide, ...surcharge };
    if (payload.quartierId === undefined) delete payload.quartierId;

    expect(await erreursSur(payload, 'quartierId')).toHaveLength(1);
  });

  it('dit au client POURQUOI, pas seulement que c’est invalide', async () => {
    const [erreur] = await erreursSur(
      { ...valide, quartierId: '' },
      'quartierId',
    );
    const message = Object.values(erreur.constraints ?? {}).join(' ');

    // « quartierId should not be empty » n'apprend rien à quelqu'un devant son
    // téléphone. Le message doit nommer la conséquence.
    expect(message).toContain('livreur');
  });

  it('laisse la position facultative — un quartier suffit à situer', async () => {
    // Exiger un point sur carte fermerait la création d'adresse à qui n'a pas
    // de GPS, refuse la permission, ou se trouve dans un bâtiment.
    expect(await erreursSur(valide, 'latitude')).toHaveLength(0);
    expect(await erreursSur(valide, 'longitude')).toHaveLength(0);
    expect(await erreursSur(valide, 'landmark')).toHaveLength(0);
  });

  it('rejette toujours une position hors bornes', async () => {
    const dto = plainToInstance(CreateAdresseDto, {
      ...valide,
      latitude: 200,
      longitude: 15.2,
    });
    const erreurs = await validate(dto);

    expect(erreurs.map((e) => e.property)).toContain('latitude');
  });
});

describe('UpdateAdresseDto — la modification reste partielle', () => {
  it('permet de corriger la rue d’une adresse ancienne sans fournir de quartier', async () => {
    // 20 adresses de production n'ont aucun quartier (juillet 2025 → mars
    // 2026). Rendre le champ obligatoire à la MISE À JOUR les rendrait
    // immodifiables : leur propriétaire ne pourrait plus corriger sa rue sans
    // d'abord résoudre un problème qu'il n'a pas créé. La complétion est
    // demandée au checkout, où elle a du sens ; elle n'est pas imposée ici.
    const dto = plainToInstance(UpdateAdresseDto, { rue: '13 rue Mbochi' });
    const erreurs = await validate(dto);

    expect(erreurs).toHaveLength(0);
  });
});
