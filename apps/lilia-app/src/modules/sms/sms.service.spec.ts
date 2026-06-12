import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';

const makeConfig = (values: Record<string, any>): ConfigService =>
  ({ get: (k: string, d?: any) => values[k] ?? d }) as unknown as ConfigService;

describe('SmsService (mode simulé)', () => {
  it('send() renvoie true sans client quand les clés manquent', async () => {
    const service = new SmsService(makeConfig({}));
    await expect(service.send('061234567', 'test')).resolves.toBe(true);
  });

  it('sendWelcome() reste sur 1 segment GSM-7 (<160 caractères, sans accents)', async () => {
    const service = new SmsService(makeConfig({}));
    const spy = jest.spyOn(service, 'send');
    await service.sendWelcome('061234567', 'Jean');
    const message = spy.mock.calls[0][1];
    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).not.toMatch(/[éèàùâêîôûçëïü]/i);
  });

  it('sendWelcome() tronque un nom très long', async () => {
    const service = new SmsService(makeConfig({}));
    const spy = jest.spyOn(service, 'send');
    await service.sendWelcome('061234567', 'Jean-Baptiste-Emmanuel-Tres-Long');
    const message = spy.mock.calls[0][1];
    expect(message.length).toBeLessThanOrEqual(160);
  });
});
