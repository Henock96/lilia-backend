import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PlatformSettings, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { appUpdateViolations } from './app-update-policy';

const SINGLETON_ID = 'singleton';
const CACHE_TTL_MS = 60_000;

/** Message du 409 — le même quelle que soit la fenêtre de course rencontrée. */
export const PLATFORM_SETTINGS_CONFLICT_MESSAGE =
  'La configuration a été modifiée par un autre administrateur depuis que vous ' +
  "l'avez ouverte. Rechargez-la pour voir les valeurs actuelles, puis refaites " +
  'vos changements.';

/** Résultat d'une mise à jour : l'état lu avant l'écriture, et celui écrit. */
export interface PlatformSettingsUpdate {
  before: PlatformSettings;
  after: PlatformSettings;
  /** Champs réellement envoyés (hors `expectedUpdatedAt`). */
  changes: Prisma.PlatformSettingsUpdateInput;
}

@Injectable()
export class PlatformSettingsService {
  private cache: PlatformSettings | null = null;
  private cacheExpiry = 0;
  /** Lecture en cours — déduplique les cache-miss concurrents (rafales de checkout). */
  private inflight: Promise<PlatformSettings> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne la configuration plateforme. Mise en cache mémoire 60 s :
   * les valeurs sont lues sur les chemins critiques (chaque commande),
   * et changent rarement. Le TTL assure l'auto-réparation multi-instances.
   *
   * Les cache-miss concurrents partagent une seule requête (`inflight`) —
   * une rafale de commandes ne déclenche pas N upserts en parallèle.
   */
  async getSettings(): Promise<PlatformSettings> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.readFresh()
      .then((settings) => {
        this.cache = settings;
        this.cacheExpiry = Date.now() + CACHE_TTL_MS;
        this.inflight = null;
        return settings;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    return this.inflight;
  }

  /**
   * Met à jour la configuration (PATCH partiel) et invalide le cache.
   *
   * ## Pourquoi pas un simple `upsert`
   *
   * L'`upsert` inconditionnel écrasait tout ce qu'on lui donnait (SET-001) et
   * ne regardait jamais l'état existant, si bien qu'un PATCH partiel pouvait
   * produire une configuration incohérente (SET-002). L'écriture suit
   * désormais quatre temps :
   *
   * 1. **lecture fraîche** — jamais le cache : les invariants et le verrou se
   *    jugent sur la base, pas sur une copie vieille de 60 s ;
   * 2. **verrou optimiste** — si le client annonce l'`updatedAt` qu'il a
   *    chargé et que la ligne a bougé depuis : 409 ;
   * 3. **invariants** — sur l'état *résultant* (base ⊕ PATCH), dès que le
   *    PATCH touche une version ;
   * 4. **écriture conditionnelle** — `UPDATE … WHERE updatedAt = <lu>` : si un
   *    autre administrateur a écrit entre 1 et 4, zéro ligne, 409. C'est
   *    PostgreSQL, pas un `if`, qui ferme la fenêtre de course.
   */
  async updateSettings(
    dto: UpdatePlatformSettingsDto,
  ): Promise<PlatformSettingsUpdate> {
    const { expectedUpdatedAt, ...fields } = dto;
    const changes = stripUndefined(fields);

    const before = await this.readFresh();

    if (
      expectedUpdatedAt !== undefined &&
      new Date(expectedUpdatedAt).getTime() !== before.updatedAt.getTime()
    ) {
      throw new ConflictException(PLATFORM_SETTINGS_CONFLICT_MESSAGE);
    }

    // Les invariants ne sont jugés que si le PATCH touche une version : un
    // état hérité incohérent ne doit pas empêcher de corriger les frais de
    // service en urgence. Il sera refusé à la prochaine écriture des versions.
    if ('minAppVersion' in changes || 'latestAppVersion' in changes) {
      const violations = appUpdateViolations({
        minAppVersion:
          'minAppVersion' in changes
            ? (changes.minAppVersion as string | null)
            : before.minAppVersion,
        latestAppVersion:
          'latestAppVersion' in changes
            ? (changes.latestAppVersion as string | null)
            : before.latestAppVersion,
      });
      if (violations.length > 0) {
        throw new BadRequestException(violations.join(' '));
      }
    }

    // F3-02 — en mode PLATFORM, un checkout sans grille publiée est refusé
    // (jamais de repli sur le prix du vendeur). Basculer sans grille fermerait
    // la caisse de toute la plateforme : c'est la bascule qu'on refuse. Le
    // retour à VENDOR_LEGACY, lui, n'exige rien — c'est la sortie de secours.
    if (
      changes.deliveryPricingMode === 'PLATFORM' &&
      before.deliveryPricingMode !== 'PLATFORM'
    ) {
      const published = await this.prisma.deliveryTariff.count({
        where: { status: 'PUBLISHED' },
      });
      if (published === 0) {
        throw new ConflictException(
          'Publiez une grille de livraison avant de passer la tarification en mode plateforme.',
        );
      }
    }

    // PATCH vide : ne rien écrire. Un UPDATE sans colonne ferait tout de même
    // avancer `updatedAt` et périmerait à tort les formulaires ouverts ailleurs.
    if (Object.keys(changes).length === 0) {
      return { before, after: before, changes };
    }

    const { count } = await this.prisma.platformSettings.updateMany({
      where: { id: SINGLETON_ID, updatedAt: before.updatedAt },
      data: changes,
    });
    if (count === 0) {
      throw new ConflictException(PLATFORM_SETTINGS_CONFLICT_MESSAGE);
    }

    const after = await this.prisma.platformSettings.findUniqueOrThrow({
      where: { id: SINGLETON_ID },
    });

    this.cache = null;
    this.cacheExpiry = 0;
    this.inflight = null;
    return { before, after, changes };
  }

  /**
   * Lit la ligne singleton, en la créant aux valeurs `@default` si elle
   * n'existe pas encore (première exécution sur une base vierge).
   */
  private readFresh(): Promise<PlatformSettings> {
    return this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
  }
}

/** `{ a: 1, b: undefined }` → `{ a: 1 }`. `null` est conservé : il efface. */
function stripUndefined(
  input: Record<string, unknown>,
): Prisma.PlatformSettingsUpdateInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Prisma.PlatformSettingsUpdateInput;
}
