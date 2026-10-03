import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios, { AxiosInstance } from 'axios';

/**
 * Météo de Brazzaville affichée en tête de l'accueil client.
 *
 * ## Pourquoi passer par le backend
 *
 * La clé OpenWeatherMap ne doit jamais être embarquée dans une app : tout
 * binaire se décompile. Les apps lisent `GET /weather/brazzaville`, le serveur
 * appelle OpenWeatherMap avec `OPENWEATHERMAP_API_KEY`.
 *
 * ## Cache — un appel fournisseur toutes les 30 min, pas un par accueil
 *
 * La valeur est mise en Redis avec son heure de relevé :
 *
 *  · moins de [FRESH_SECONDS] → servie telle quelle ;
 *  · au-delà → on relit OpenWeatherMap ;
 *  · relecture en échec et valeur de moins de [MAX_AGE_SECONDS] → on sert la
 *    dernière valeur connue ; `updatedAt` dit son âge, l'app décide ;
 *  · rien d'exploitable → 503. **Jamais** une température inventée.
 *
 * Sans Redis (développement), un cache mémoire du processus prend le relais.
 *
 * ## Licence
 *
 * Plan Free OpenWeather : usage commercial autorisé (ODbL), **attribution
 * obligatoire** dans une partie visible de l'app. Le texte et le lien voyagent
 * dans la réponse (`attribution`) pour que toutes les apps l'affichent pareil.
 */
export const BRAZZAVILLE = { lat: -4.2634, lon: 15.2429 } as const;

export const WEATHER_ATTRIBUTION = {
  text: 'Weather data provided by OpenWeather',
  url: 'https://openweathermap.org/',
} as const;

export interface BrazzavilleWeather {
  city: 'Brazzaville';
  /** °C, arrondi à l'entier. */
  temperatureC: number;
  /** Identifiant de condition OpenWeatherMap (200–804). */
  conditionCode: number;
  /** Description en français fournie par OpenWeatherMap (`lang=fr`). */
  description: string;
  isDay: boolean;
  /** Heure de l'observation chez OpenWeatherMap (ISO 8601). */
  observedAt: string;
  /** Heure à laquelle Lilia a lu la valeur (ISO 8601). */
  updatedAt: string;
  attribution: typeof WEATHER_ATTRIBUTION;
}

const CACHE_KEY = 'weather:brazzaville:v1';
const FRESH_SECONDS = 30 * 60;
const MAX_AGE_SECONDS = 2 * 60 * 60;
const TIMEOUT_MS = 5000;

/** Forme utile de la réponse OpenWeatherMap — partielle et défensive. */
interface OwmCurrent {
  dt?: number;
  main?: { temp?: number };
  weather?: { id?: number; description?: string; icon?: string }[];
  sys?: { sunrise?: number; sunset?: number };
}

@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  private readonly apiKey: string;
  private memory: BrazzavilleWeather | null = null;
  /** Client HTTP — remplaçable dans les tests. */
  http: AxiosInstance = axios.create();

  constructor(
    config: ConfigService,
    @Optional() @InjectRedis() private readonly redis?: Redis,
  ) {
    this.apiKey = (config.get<string>('OPENWEATHERMAP_API_KEY') ?? '').trim();
    if (!this.apiKey) {
      this.logger.warn(
        'Météo désactivée — OPENWEATHERMAP_API_KEY manquante (GET /weather/brazzaville → 503)',
      );
    }
  }

  async getBrazzaville(now: Date = new Date()): Promise<BrazzavilleWeather> {
    const cached = await this.readCache();
    const age = cached ? ageSeconds(cached, now) : Infinity;
    if (cached && age < FRESH_SECONDS) return cached;

    if (this.apiKey) {
      try {
        const fresh = await this.fetchFromProvider(now);
        await this.writeCache(fresh);
        return fresh;
      } catch (e) {
        // ⚠️ Ne jamais journaliser l'erreur axios brute : son `config.url`
        // contient `appid=<clé>`.
        this.logger.warn(`OpenWeatherMap indisponible : ${describe(e)}`);
      }
    }

    if (cached && age < MAX_AGE_SECONDS) return cached;
    throw new ServiceUnavailableException('Météo indisponible pour le moment.');
  }

  private async fetchFromProvider(now: Date): Promise<BrazzavilleWeather> {
    const res = await this.http.get<OwmCurrent>(
      'https://api.openweathermap.org/data/2.5/weather',
      {
        params: {
          lat: BRAZZAVILLE.lat,
          lon: BRAZZAVILLE.lon,
          units: 'metric',
          lang: 'fr',
          appid: this.apiKey,
        },
        timeout: TIMEOUT_MS,
      },
    );
    return normalize(res.data, now);
  }

  private async readCache(): Promise<BrazzavilleWeather | null> {
    if (!this.redis) return this.memory;
    try {
      const raw = await this.redis.get(CACHE_KEY);
      return raw ? (JSON.parse(raw) as BrazzavilleWeather) : null;
    } catch (e) {
      this.logger.warn(`Cache météo illisible : ${describe(e)}`);
      return this.memory;
    }
  }

  private async writeCache(value: BrazzavilleWeather): Promise<void> {
    this.memory = value;
    if (!this.redis) return;
    try {
      await this.redis.set(
        CACHE_KEY,
        JSON.stringify(value),
        'EX',
        MAX_AGE_SECONDS,
      );
    } catch (e) {
      this.logger.warn(`Cache météo non écrit : ${describe(e)}`);
    }
  }
}

/**
 * Réponse OpenWeatherMap → contrat Lilia. Rejette toute réponse sans
 * température ou sans condition : mieux vaut pas de météo qu'une fausse.
 */
export function normalize(raw: OwmCurrent, now: Date): BrazzavilleWeather {
  const temp = raw?.main?.temp;
  const w = raw?.weather?.[0];
  if (typeof temp !== 'number' || !Number.isFinite(temp)) {
    throw new Error('réponse sans température');
  }
  if (typeof w?.id !== 'number') {
    throw new Error('réponse sans condition');
  }
  const dt =
    typeof raw.dt === 'number' ? raw.dt : Math.floor(now.getTime() / 1000);
  const { sunrise, sunset } = raw.sys ?? {};
  const isDay =
    typeof sunrise === 'number' && typeof sunset === 'number'
      ? dt >= sunrise && dt < sunset
      : !String(w.icon ?? '').endsWith('n');
  return {
    city: 'Brazzaville',
    temperatureC: Math.round(temp),
    conditionCode: w.id,
    description: capitalize(String(w.description ?? '').trim()),
    isDay,
    observedAt: new Date(dt * 1000).toISOString(),
    updatedAt: now.toISOString(),
    attribution: WEATHER_ATTRIBUTION,
  };
}

function ageSeconds(w: BrazzavilleWeather, now: Date): number {
  const t = Date.parse(w.updatedAt);
  return Number.isFinite(t) ? (now.getTime() - t) / 1000 : Infinity;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Résumé d'erreur sans URL ni paramètres (la clé est dans l'URL). */
function describe(e: unknown): string {
  if (axios.isAxiosError(e)) {
    return e.response
      ? `HTTP ${e.response.status}`
      : (e.code ?? 'erreur réseau');
  }
  return e instanceof Error ? e.message : 'erreur inconnue';
}
