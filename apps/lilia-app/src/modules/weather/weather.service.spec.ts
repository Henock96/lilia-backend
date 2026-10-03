import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosInstance } from 'axios';
import {
  normalize,
  WeatherService,
  WEATHER_ATTRIBUTION,
} from './weather.service';

/** Redis réduit à ce que le service utilise. */
class FakeRedis {
  store = new Map<string, string>();
  ttl = new Map<string, number>();
  get = jest.fn(async (k: string) => this.store.get(k) ?? null);
  set = jest.fn(async (k: string, v: string, _ex: string, s: number) => {
    this.store.set(k, v);
    this.ttl.set(k, s);
    return 'OK';
  });
}

const OWM_OK = {
  dt: 1790974800, // 2026-10-02T21:00:00Z
  main: { temp: 24.9 },
  weather: [{ id: 801, description: 'peu nuageux', icon: '02n' }],
  sys: { sunrise: 1790915000, sunset: 1790958700 },
};

function build(opts: { key?: string; redis?: FakeRedis | null } = {}) {
  const config = new ConfigService({
    OPENWEATHERMAP_API_KEY: opts.key ?? 'test-key',
  });
  const redis = opts.redis === undefined ? new FakeRedis() : opts.redis;
  const service = new WeatherService(config, (redis ?? undefined) as never);
  const get = jest.fn();
  service.http = { get } as unknown as AxiosInstance;
  return { service, get, redis };
}

const T0 = new Date('2026-10-02T21:05:00Z');
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('WeatherService', () => {
  it('normalise la réponse OpenWeatherMap (contrat minimal, attribution)', async () => {
    const { service, get } = build();
    get.mockResolvedValue({ data: OWM_OK });
    const w = await service.getBrazzaville(T0);
    expect(w).toEqual({
      city: 'Brazzaville',
      temperatureC: 25,
      conditionCode: 801,
      description: 'Peu nuageux',
      isDay: false,
      observedAt: '2026-10-02T21:00:00.000Z',
      updatedAt: T0.toISOString(),
      attribution: WEATHER_ATTRIBUTION,
    });
    // Coordonnées fixes, unités métriques, français, délai borné.
    const [url, cfg] = get.mock.calls[0];
    expect(url).toBe('https://api.openweathermap.org/data/2.5/weather');
    expect(cfg.params).toMatchObject({
      lat: -4.2634,
      lon: 15.2429,
      units: 'metric',
      lang: 'fr',
      appid: 'test-key',
    });
    expect(cfg.timeout).toBe(5000);
  });

  it('la clé ne fuit jamais dans la réponse', async () => {
    const { service, get } = build({ key: 'secret-owm-key' });
    get.mockResolvedValue({ data: OWM_OK });
    const w = await service.getBrazzaville(T0);
    expect(JSON.stringify(w)).not.toContain('secret-owm-key');
  });

  it('cache : un seul appel fournisseur pendant 30 min', async () => {
    const { service, get, redis } = build();
    get.mockResolvedValue({ data: OWM_OK });
    await service.getBrazzaville(T0);
    await service.getBrazzaville(plus(10));
    await service.getBrazzaville(plus(29));
    expect(get).toHaveBeenCalledTimes(1);
    expect([...redis!.ttl.values()][0]).toBe(2 * 60 * 60);
    await service.getBrazzaville(plus(31));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fournisseur en panne : dernière valeur de moins de 2 h, âge dans updatedAt', async () => {
    const { service, get } = build();
    get.mockResolvedValueOnce({ data: OWM_OK });
    await service.getBrazzaville(T0);
    get.mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED'));
    const w = await service.getBrazzaville(plus(45));
    expect(w.temperatureC).toBe(25);
    expect(w.updatedAt).toBe(T0.toISOString());
  });

  it('fournisseur en panne et rien de récent : 503, jamais une valeur inventée', async () => {
    const { service, get } = build();
    get.mockResolvedValueOnce({ data: OWM_OK });
    await service.getBrazzaville(T0);
    get.mockRejectedValue(new AxiosError('boom', 'ECONNRESET'));
    await expect(service.getBrazzaville(plus(121))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('timeout au premier appel : 503', async () => {
    const { service, get } = build();
    get.mockRejectedValue(
      new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED'),
    );
    await expect(service.getBrazzaville(T0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('clé absente : 503 sans appeler le fournisseur', async () => {
    const { service, get } = build({ key: '' });
    await expect(service.getBrazzaville(T0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('réponse invalide : rejetée (503), rien en cache', async () => {
    const { service, get, redis } = build();
    get.mockResolvedValue({ data: { weather: [{ id: 800 }] } });
    await expect(service.getBrazzaville(T0)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(redis!.set).not.toHaveBeenCalled();
  });

  it('sans Redis : cache mémoire du processus', async () => {
    const { service, get } = build({ redis: null });
    get.mockResolvedValue({ data: OWM_OK });
    await service.getBrazzaville(T0);
    await service.getBrazzaville(plus(5));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('normalize', () => {
  it('jour/nuit : lever et coucher du soleil, sinon suffixe de l’icône', () => {
    const jour = normalize({ ...OWM_OK, dt: 1790930000 }, T0);
    expect(jour.isDay).toBe(true);
    const sansSys = normalize(
      { dt: 1, main: { temp: 20 }, weather: [{ id: 500, icon: '10d' }] },
      T0,
    );
    expect(sansSys.isDay).toBe(true);
  });
});
