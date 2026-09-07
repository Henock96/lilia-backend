import { Test, TestingModule } from '@nestjs/testing';
import { ReferralRewardStatus } from '@prisma/client';

import { ReferralRiskService } from './referral-risk.service';
import { PrismaService } from '../../prisma/prisma.service';
import { decideFromScore } from './referral-risk.config';

/**
 * Scoring anti-abus du parrainage — les sept cas du cahier des charges.
 *
 * ## Ce que ces tests protègent vraiment
 *
 * Deux propriétés opposées, également importantes :
 *
 *  - **le fraudeur est vu** : des comptes en série sur un même appareil, pour
 *    un même parrain, montent au-dessus du seuil de refus ;
 *  - **la famille ne l'est pas** : un appareil partagé par deux personnes aux
 *    numéros distincts reste sous le seuil de revue.
 *
 * Un système anti-fraude qui n'échoue que dans le premier sens est facile à
 * écrire et inutilisable en production. C'est le cas E qui garde le reste
 * honnête.
 */
describe('ReferralRiskService — les sept cas', () => {
  let service: ReferralRiskService;

  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    deviceInstallation: { findMany: jest.fn() },
    referralReward: { count: jest.fn() },
  };

  const FILLEUL = 'filleul-1';
  const PARRAIN = 'parrain-1';

  /**
   * Prépare l'état de la base pour un scénario.
   * @param phone            téléphone du filleul (`null` = non renseigné)
   * @param installations    installations d'où le filleul s'est connecté
   * @param otherAccounts    autres comptes vus sur ces installations
   * @param otherPhones      téléphones portés par d'autres comptes
   * @param priorRewards     filleuls du même parrain déjà convertis sur ces installations
   * @param recentRewards    récompenses versées au parrain sur 24 h
   */
  function given({
    phone = '061234567',
    installations = ['inst-A'],
    otherAccounts = [] as string[],
    otherPhones = [] as string[],
    priorRewards = 0,
    recentRewards = 0,
    blocked = false,
  }) {
    prisma.user.findUnique.mockResolvedValue({ id: FILLEUL, phone });
    prisma.deviceInstallation.findMany.mockImplementation(({ where }: any) => {
      // Premier appel : les installations du filleul.
      if (where.userId === FILLEUL) {
        return Promise.resolve(
          installations.map((installationId) => ({
            installationId,
            status: blocked ? 'BLOCKED' : 'ACTIVE',
          })),
        );
      }
      // Second appel : les autres comptes sur ces installations.
      return Promise.resolve(otherAccounts.map((userId) => ({ userId })));
    });
    prisma.user.findMany.mockResolvedValue(
      otherPhones.map((p, i) => ({ id: `autre-${i}`, phone: p })),
    );
    prisma.referralReward.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.decidedAt ? recentRewards : priorRewards),
    );
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralRiskService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ReferralRiskService);
  });

  // ─── Cas A — parrainage normal ────────────────────────────────────────────

  it('Cas A — appareil vierge, téléphone unique → approuvé, score 0', async () => {
    given({});

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.score).toBe(0);
    expect(result.status).toBe(ReferralRewardStatus.APPROVED);
    expect(result.signals).toHaveLength(0);
  });

  // ─── Cas B — deuxième compte, même appareil, même parrain ─────────────────

  it('Cas B — 2ᵉ compte sur le même appareil pour le même parrain → revue', async () => {
    given({ otherAccounts: ['compte-precedent'], priorRewards: 1 });

    const result = await service.assess(FILLEUL, PARRAIN);

    // DEVICE_SHARED (25) + DEVICE_SAME_REFERRER (40) = 65
    expect(result.score).toBe(65);
    expect(result.status).toBe(ReferralRewardStatus.PENDING_REVIEW);
    expect(result.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(['DEVICE_SHARED', 'DEVICE_SAME_REFERRER']),
    );
  });

  // ─── Cas C — la ferme à comptes ───────────────────────────────────────────

  it('Cas C — 10 comptes, même appareil, même parrain → refusé', async () => {
    given({
      otherAccounts: Array.from({ length: 9 }, (_, i) => `bidon-${i}`),
      priorRewards: 5,
      recentRewards: 5,
    });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.status).toBe(ReferralRewardStatus.REJECTED);
    expect(result.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining([
        'DEVICE_SHARED',
        'DEVICE_ACCOUNT_FARM',
        'DEVICE_SAME_REFERRER',
        'REFERRER_VELOCITY',
      ]),
    );
  });

  it('le partage d’appareil est plafonné — 50 quel que soit le nombre de comptes', async () => {
    given({
      otherAccounts: Array.from({ length: 40 }, (_, i) => `bidon-${i}`),
    });

    const result = await service.assess(FILLEUL, PARRAIN);
    const shared = result.signals.find((s) => s.code === 'DEVICE_SHARED');

    expect(shared?.weight).toBe(50);
  });

  // ─── Cas D et F — le téléphone ────────────────────────────────────────────

  it('Cas D — même téléphone sur plusieurs comptes → revue', async () => {
    given({ phone: '061234567', otherPhones: ['061234567'] });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.score).toBe(65);
    expect(result.status).toBe(ReferralRewardStatus.PENDING_REVIEW);
  });

  it('Cas F — appareil différent mais même téléphone → détecté quand même', async () => {
    given({
      installations: ['inst-neuve'],
      otherAccounts: [],
      phone: '+242 06 123 45 67',
      otherPhones: ['061234567'],
    });

    const result = await service.assess(FILLEUL, PARRAIN);

    // La normalisation rapproche les deux écritures du même numéro : changer
    // de format n'échappe pas au signal.
    expect(result.signals.map((s) => s.code)).toContain('PHONE_REUSED');
    expect(result.status).toBe(ReferralRewardStatus.PENDING_REVIEW);
  });

  it('des numéros réellement différents ne déclenchent rien', async () => {
    given({ phone: '061234567', otherPhones: ['069999999', '055555555'] });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.signals.map((s) => s.code)).not.toContain('PHONE_REUSED');
  });

  // ─── Cas E — la famille qu'il ne faut PAS bloquer ─────────────────────────

  it('Cas E — deux personnes légitimes, même appareil, numéros distincts → approuvé', async () => {
    given({
      otherAccounts: ['conjoint'],
      phone: '061234567',
      otherPhones: ['069999999'],
      priorRewards: 0,
    });

    const result = await service.assess(FILLEUL, PARRAIN);

    // 25 seulement : sous le seuil de revue (61). C'est la propriété qui rend
    // le système utilisable — refuser ici punirait un couple.
    expect(result.score).toBe(25);
    expect(result.status).toBe(ReferralRewardStatus.APPROVED);
  });

  // ─── Cas G — historique suspect ───────────────────────────────────────────

  it('Cas G — appareil déjà utilisé pour convertir un filleul du même parrain', async () => {
    given({ otherAccounts: ['ancien-filleul'], priorRewards: 1 });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.status).not.toBe(ReferralRewardStatus.APPROVED);
  });

  it('une installation bloquée par un administrateur refuse directement', async () => {
    given({ blocked: true });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.score).toBe(100);
    expect(result.status).toBe(ReferralRewardStatus.REJECTED);
  });

  // ─── Signaux d'identité faible et données manquantes ──────────────────────

  it('un compte sans téléphone est un signal faible, pas un refus', async () => {
    given({ phone: null });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.score).toBe(15);
    expect(result.status).toBe(ReferralRewardStatus.APPROVED);
  });

  it('aucune installation connue : signal absent, jamais présumé', async () => {
    // Une version d'app antérieure à l'en-tête n'envoie rien. On n'invente pas
    // un risque à partir d'une donnée manquante — et on n'en absout pas non plus.
    given({ installations: [] });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.signals.map((s) => s.code)).not.toContain('DEVICE_SHARED');
    expect(result.status).toBe(ReferralRewardStatus.APPROVED);
  });

  it('le score est borné à 100', async () => {
    given({
      blocked: true,
      otherAccounts: Array.from({ length: 20 }, (_, i) => `x-${i}`),
      otherPhones: ['061234567'],
      phone: '061234567',
      priorRewards: 3,
      recentRewards: 9,
    });

    const result = await service.assess(FILLEUL, PARRAIN);

    expect(result.score).toBe(100);
  });

  // ─── Les bandes de décision ───────────────────────────────────────────────

  describe('decideFromScore — les quatre bandes', () => {
    it.each([
      [0, ReferralRewardStatus.APPROVED],
      [30, ReferralRewardStatus.APPROVED],
      // 31–60 : crédité, mais journalisé. Un signal isolé n'est pas une fraude,
      // et faire attendre un parrain légitime abîmerait le programme plus
      // sûrement que le fraudeur qu'on cherche.
      [31, ReferralRewardStatus.APPROVED],
      [60, ReferralRewardStatus.APPROVED],
      [61, ReferralRewardStatus.PENDING_REVIEW],
      [80, ReferralRewardStatus.PENDING_REVIEW],
      [81, ReferralRewardStatus.REJECTED],
      [100, ReferralRewardStatus.REJECTED],
    ])('score %i → %s', (score, expected) => {
      expect(decideFromScore(score)).toBe(expected);
    });
  });
});
