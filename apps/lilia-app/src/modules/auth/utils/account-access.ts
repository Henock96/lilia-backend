import { StatusUser } from '@prisma/client';

/**
 * Statuts qui coupent l'accès à **tout** contexte authentifié, et le message
 * rendu à l'appelant.
 *
 * Volontairement partagé entre `RolesGuard` (HTTP) et
 * `TrackingGateway.assertSessionStillValid` (WebSocket) : le premier contrôle
 * `BLOCKED` avait été dupliqué entre les deux transports, et l'audit d'août 2026
 * a montré qu'une divergence y passe inaperçue — la socket restait ouverte pour
 * un compte que le chemin HTTP rejetait déjà.
 */
const REVOKED_STATUSES: Partial<Record<StatusUser, string>> = {
  BLOCKED: 'Votre compte a été suspendu.',
  DELETED: 'Ce compte a été supprimé.',
};

/**
 * Retourne le message de refus si le statut interdit l'accès, `null` sinon.
 * Un `statusUser` inconnu (enum élargi sans passer ici) est traité comme
 * autorisé : c'est le comportement historique, un ajout d'enum ne doit pas
 * verrouiller silencieusement des comptes actifs.
 */
export function accessRevocationReason(
  statusUser: StatusUser | null | undefined,
): string | null {
  if (!statusUser) return null;
  return REVOKED_STATUSES[statusUser] ?? null;
}
