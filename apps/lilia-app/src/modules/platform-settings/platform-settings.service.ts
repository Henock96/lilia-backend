import { Injectable } from '@nestjs/common';
import { PlatformSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';

const SINGLETON_ID = 'singleton';
const CACHE_TTL_MS = 60_000;

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

    this.inflight = this.prisma.platformSettings
      .upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        update: {},
      })
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
   */
  async updateSettings(dto: UpdatePlatformSettingsDto): Promise<PlatformSettings> {
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      // Branche `create` : si la ligne singleton n'existe pas encore, les champs
      // absents du DTO partiel prennent les valeurs `@default` du modèle Prisma.
      create: { id: SINGLETON_ID, ...dto },
      update: { ...dto },
    });
    this.cache = null;
    this.cacheExpiry = 0;
    this.inflight = null;
    return settings;
  }
}
