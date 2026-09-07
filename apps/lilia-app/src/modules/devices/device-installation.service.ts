import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Longueur maximale acceptée pour un identifiant d'installation.
 * Un UUID v4 en fait 36 ; on laisse de la marge sans ouvrir la porte à une
 * chaîne arbitraire de plusieurs kilooctets.
 */
const MAX_INSTALLATION_ID_LENGTH = 64;

/** UUID, ULID, nanoid : lettres, chiffres, tirets et underscores. */
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const KNOWN_PLATFORMS = ['android', 'ios', 'web'] as const;

/**
 * Enregistrement des installations applicatives.
 *
 * ## Ce que c'est
 *
 * Un UUID **généré par le client** au premier lancement et conservé
 * localement (`shared_preferences` sur mobile, `localStorage` sur le web),
 * envoyé en en-tête `X-Lilia-Installation-Id`.
 *
 * ## Ce que ce n'est pas
 *
 * Ce n'est **pas** une identité d'appareil. Aucune donnée matérielle n'est
 * collectée — ni IMEI, ni adresse MAC, ni numéro de série : leur usage est
 * restreint sur Android comme sur iOS, et surtout il n'apporterait rien qu'un
 * identifiant applicatif n'apporte déjà pour l'usage visé.
 *
 * Il se réinitialise à la désinstallation et se partage dès qu'un téléphone
 * l'est. C'est pourquoi il **pondère** une décision de récompense
 * (`ReferralRiskService`) et n'en prend jamais aucune seul.
 *
 * ## Où il est capté
 *
 * Au seul `POST /users/sync`, qui est traversé par **tous** les modes de
 * connexion — e-mail, Google, Apple — à chaque ouverture de session. Un point
 * de capture unique plutôt qu'un intercepteur global : le signal n'a de valeur
 * qu'au moment où un compte s'identifie, et un intercepteur écrirait à chaque
 * requête pour la même information.
 */
@Injectable()
export class DeviceInstallationService {
  private readonly logger = new Logger(DeviceInstallationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valide un identifiant reçu d'un client. Rend `null` pour toute valeur
   * absente ou mal formée — un signal manquant n'est pas une erreur : les
   * versions déjà installées n'en envoient pas, et refuser leur connexion
   * serait hors de proportion.
   */
  static sanitizeInstallationId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (value.length === 0 || value.length > MAX_INSTALLATION_ID_LENGTH) {
      return null;
    }
    return INSTALLATION_ID_PATTERN.test(value) ? value : null;
  }

  static sanitizePlatform(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    return (KNOWN_PLATFORMS as readonly string[]).includes(value)
      ? value
      : null;
  }

  /**
   * Note qu'un compte s'est identifié depuis une installation.
   *
   * **Jamais bloquant** : l'échec d'un signal anti-abus ne doit pas empêcher
   * quelqu'un de se connecter. C'est le même arbitrage que pour le journal
   * d'audit admin — la fonctionnalité principale prime sur son observation.
   */
  async register(
    userId: string,
    installationId: string | null,
    platform: string | null,
  ): Promise<void> {
    if (!installationId) return;

    try {
      const now = new Date();
      await this.prisma.deviceInstallation.upsert({
        where: {
          installationId_userId: { installationId, userId },
        },
        create: {
          installationId,
          userId,
          platform,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        // `firstSeenAt` n'est jamais réécrit : c'est la date qui dit depuis
        // quand ce couple existe, et c'est elle qui donnera sa valeur au signal.
        update: {
          lastSeenAt: now,
          ...(platform ? { platform } : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Installation non enregistrée (user ${userId}) : ${(error as Error).message}`,
      );
    }
  }

  /** Comptes distincts vus depuis une installation — lecture de supervision. */
  async countAccounts(installationId: string): Promise<number> {
    const rows = await this.prisma.deviceInstallation.findMany({
      where: { installationId },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }
}
