import { AdminAlertService } from './admin-alert.service';

/**
 * Diffusion des alertes d'exploitation aux administrateurs.
 *
 * Le comportement à figer n'est pas « une notification part » — c'était déjà
 * vrai avant, et pourtant les trois comptes ADMIN de production n'ont jamais
 * rien reçu, faute de token FCM. Ce qui compte ici, c'est que **la disparition
 * d'un canal ne fasse pas disparaître l'alerte**, et que le silence total soit
 * signalé plutôt que subi.
 */
describe('AdminAlertService', () => {
  let service: AdminAlertService;

  const prisma = { user: { findMany: jest.fn() } };
  const notifications = { sendPushNotification: jest.fn() };
  const email = { isReady: jest.fn(), sendEmail: jest.fn() };

  const ADMINS = [
    { id: 'a1', email: 'admin1@liliafood.com', nom: 'Admin Un' },
    { id: 'a2', email: 'admin2@liliafood.com', nom: 'Admin Deux' },
  ];

  const alert = {
    title: '🛎️ Nouveau vendeur à valider',
    body: 'Chez Maman Lili attend votre validation.',
    data: { vendorId: 'v1', type: 'vendor_pending_approval' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findMany.mockResolvedValue(ADMINS);
    notifications.sendPushNotification.mockResolvedValue(undefined);
    email.isReady.mockReturnValue(true);
    email.sendEmail.mockResolvedValue(true);
    service = new AdminAlertService(
      prisma as never,
      notifications as never,
      email as never,
    );
  });

  it('diffuse sur les deux canaux à tous les administrateurs actifs', async () => {
    const res = await service.notify(alert);

    expect(res).toEqual({ admins: 2, pushed: 2, emailed: 2 });
    expect(notifications.sendPushNotification).toHaveBeenCalledTimes(2);
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('ne s’adresse qu’aux comptes ADMIN actifs', async () => {
    await service.notify(alert);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: 'ADMIN', statusUser: 'ACTIVE' },
      }),
    );
  });

  it('l’e-mail passe quand AUCUN admin n’a de token FCM', async () => {
    // L'état réel de la production au 4 septembre 2026 : 0 token sur 3 comptes.
    // `sendPushNotification` ne lève pas dans ce cas — elle journalise et rend.
    // C'est l'e-mail qui fait que l'alerte atteint quelqu'un.
    const res = await service.notify(alert);
    expect(res.emailed).toBe(2);
  });

  it('le push part même si le service e-mail est éteint', async () => {
    email.isReady.mockReturnValue(false);
    const res = await service.notify(alert);
    expect(res.pushed).toBe(2);
    expect(res.emailed).toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('un canal en échec n’emporte pas l’autre', async () => {
    notifications.sendPushNotification.mockRejectedValue(new Error('FCM down'));
    const res = await service.notify(alert);
    expect(res.pushed).toBe(0);
    expect(res.emailed).toBe(2);
  });

  it('un destinataire en échec n’emporte pas les autres', async () => {
    email.sendEmail
      .mockResolvedValueOnce(false) // Resend a refusé
      .mockResolvedValueOnce(true);
    const res = await service.notify(alert);
    expect(res.emailed).toBe(1);
  });

  it('n’écrit pas aux comptes anonymisés', async () => {
    prisma.user.findMany.mockResolvedValue([
      ...ADMINS,
      { id: 'a3', email: 'deleted-a3@deleted.liliafood.com', nom: null },
    ]);
    await service.notify(alert);

    const recipients = email.sendEmail.mock.calls.map(
      (c: [{ to: string }]) => c[0].to,
    );
    expect(recipients).toEqual([
      'admin1@liliafood.com',
      'admin2@liliafood.com',
    ]);
    // Le push, lui, part quand même : un compte supprimé n'a plus de token.
    expect(notifications.sendPushNotification).toHaveBeenCalledTimes(3);
  });

  it('ne lève jamais quand il n’y a aucun administrateur', async () => {
    // Une alerte est un effet de bord d'un geste déjà accompli : la faire
    // échouer défairait quelque chose de plus important qu'elle.
    prisma.user.findMany.mockResolvedValue([]);
    await expect(service.notify(alert)).resolves.toEqual({
      admins: 0,
      pushed: 0,
      emailed: 0,
    });
    expect(notifications.sendPushNotification).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('retire l’émoji de l’objet de l’e-mail', async () => {
    await service.notify(alert);
    const subject = (email.sendEmail.mock.calls[0] as [{ subject: string }])[0]
      .subject;
    expect(subject).toBe('[Lilia Food] Nouveau vendeur à valider');
  });

  it('échappe le HTML du corps — un nom de vendeur n’est pas du balisage', async () => {
    await service.notify({
      title: 'Incident',
      body: '<script>alert(1)</script> chez « Chez A&B »',
    });
    const html = (email.sendEmail.mock.calls[0] as [{ html: string }])[0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A&amp;B');
  });

  it('ajoute le lien d’administration quand il est fourni', async () => {
    await service.notify({
      ...alert,
      href: 'https://admin.liliafood.com/vendeurs',
    });
    const html = (email.sendEmail.mock.calls[0] as [{ html: string }])[0].html;
    expect(html).toContain('https://admin.liliafood.com/vendeurs');
  });
});
