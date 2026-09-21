import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';

const makeConfig = (values: Record<string, any>): ConfigService =>
  ({ get: (k: string, d?: any) => values[k] ?? d }) as unknown as ConfigService;

describe('SmsService (non configuré)', () => {
  // ⚠️ Ce test affirmait `resolves.toBe(true)` — « pas de clés » se lisait donc
  // « envoyé », et c'est cette valeur qui faisait écrire `welcomeSmsSentAt` et
  // `escalatedAt` sur des envois qui n'avaient jamais eu lieu. Le mode dégradé
  // reste le même (on ne jette pas, on ne bloque rien) ; seul son NOM change,
  // pour que les appelants puissent le distinguer d'un succès.
  it('send() rend SKIPPED — jamais un succès — quand les clés manquent', async () => {
    const service = new SmsService(makeConfig({}));
    await expect(service.send('061234567', 'test')).resolves.toBe('SKIPPED');
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

describe('SmsService — lecture de la réponse Infobip', () => {
  const enabled = () =>
    makeConfig({
      INFOBIP_API_KEY: 'cle',
      INFOBIP_BASE_URL: 'test.api.infobip.com',
      INFOBIP_SENDER: 'LiliaFood',
    });

  /** Remplace la seule frontière réseau : le client SDK. */
  const stubClient = (service: SmsService, response: unknown) => {
    const send = jest.fn().mockResolvedValue(response);
    (service as unknown as { client: unknown }).client = {
      channels: { sms: { send } },
    };
    return send;
  };

  it('rend FAILED quand Infobip répond 200 avec un message REJECTED', async () => {
    // C'est la réponse réelle d'un compte d'essai vers un numéro non vérifié :
    // HTTP 200, donc axios ne lève pas, mais le message n'est jamais livré.
    const service = new SmsService(enabled());
    stubClient(service, {
      data: {
        messages: [
          {
            to: '+242061234567',
            status: {
              groupId: 5,
              groupName: 'REJECTED',
              name: 'REJECTED_DESTINATION',
              description: 'Free trial: destination not verified',
            },
          },
        ],
      },
    });

    await expect(service.send('061234567', 'test')).resolves.toBe('FAILED');
  });

  it('rend SENT quand Infobip accepte le message', async () => {
    const service = new SmsService(enabled());
    stubClient(service, {
      data: {
        messages: [
          {
            to: '+242061234567',
            messageId: 'abc',
            status: {
              groupId: 1,
              groupName: 'PENDING',
              name: 'PENDING_ACCEPTED',
            },
          },
        ],
      },
    });

    await expect(service.send('061234567', 'test')).resolves.toBe('SENT');
  });

  it('rend FAILED quand la réponse est illisible — une absence de preuve n’est pas une preuve d’envoi', async () => {
    const service = new SmsService(enabled());
    stubClient(service, { data: {} });

    await expect(service.send('061234567', 'test')).resolves.toBe('FAILED');
  });

  it('rend FAILED quand le SDK lève (clé révoquée, réseau)', async () => {
    const service = new SmsService(enabled());
    (service as unknown as { client: unknown }).client = {
      channels: {
        sms: { send: jest.fn().mockRejectedValue(new Error('401')) },
      },
    };

    await expect(service.send('061234567', 'test')).resolves.toBe('FAILED');
  });

  it('rend SKIPPED — et non SENT — quand le service n’est pas configuré', async () => {
    // Le cœur du défaut : « pas configuré » se lisait « envoyé », donc les
    // appelants écrivaient welcomeSmsSentAt / escalatedAt sur du vide.
    const service = new SmsService(makeConfig({}));
    await expect(service.send('061234567', 'test')).resolves.toBe('SKIPPED');
  });
});
