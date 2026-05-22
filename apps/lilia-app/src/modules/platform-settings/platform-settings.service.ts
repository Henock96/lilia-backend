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

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne la configuration plateforme. Mise en cache mémoire 60 s :
   * les valeurs sont lues sur les chemins critiques (chaque commande),
   * et changent rarement. Le TTL assure l'auto-réparation multi-instances.
   */
  async getSettings(): Promise<PlatformSettings> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    this.cache = settings;
    this.cacheExpiry = Date.now() + CACHE_TTL_MS;
    return settings;
  }

  /**
   * Met à jour la configuration (PATCH partiel) et invalide le cache.
   */
  async updateSettings(dto: UpdatePlatformSettingsDto): Promise<PlatformSettings> {
    const settings = await this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...dto },
      update: { ...dto },
    });
    this.cache = null;
    this.cacheExpiry = 0;
    return settings;
  }
}
