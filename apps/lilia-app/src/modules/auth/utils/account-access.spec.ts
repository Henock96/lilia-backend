import { accessRevocationReason } from './account-access';

/**
 * Logique de révocation partagée HTTP (RolesGuard) / WebSocket
 * (TrackingGateway) : la duplication précédente avait laissé la socket ouverte
 * pour des comptes que le chemin HTTP rejetait déjà (audit août 2026, M-7).
 */
describe('accessRevocationReason', () => {
  it('ACTIVE / INACTIVE → accès autorisé', () => {
    expect(accessRevocationReason('ACTIVE')).toBeNull();
    expect(accessRevocationReason('INACTIVE')).toBeNull();
  });

  it('BLOCKED → suspendu', () => {
    expect(accessRevocationReason('BLOCKED')).toBe(
      'Votre compte a été suspendu.',
    );
  });

  it('DELETED → supprimé (message distinct du ban)', () => {
    expect(accessRevocationReason('DELETED')).toBe('Ce compte a été supprimé.');
  });

  it('statut absent → autorisé (pas de verrouillage silencieux)', () => {
    expect(accessRevocationReason(null)).toBeNull();
    expect(accessRevocationReason(undefined)).toBeNull();
  });
});
