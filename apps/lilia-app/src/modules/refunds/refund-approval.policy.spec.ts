import { RefundStatus } from '@prisma/client';

import { approvalPayloadHash } from '../approvals/approval-rules';
import {
  closureFromPayload,
  closureNeedsApproval,
  executionNeedsApproval,
  refundClosurePayload,
} from './refund-approval.policy';
import { refundApprovalPayload } from './refund-execution.service';

/**
 * R-01 (audit Admin du 07/10/2026) — une seule règle pour les 4 yeux d'un
 * remboursement, quel que soit le chemin : virement (`/execute`), clôture
 * déclarative (`PATCH /status`) ou compositeur. Le chemin déclaratif n'en
 * avait aucune : un administrateur seul clôturait ou refusait n'importe quel
 * montant.
 */
describe('refund-approval.policy', () => {
  describe('executionNeedsApproval', () => {
    it.each([
      [49_999, false],
      [50_000, true],
      [50_001, true],
    ])('%i FCFA par un administrateur → %s', (amount, expected) => {
      expect(executionNeedsApproval({ amount }, 'admin-a')).toBe(expected);
    });

    it("l'exécution automatique (faute vendeur, D2) n'est pas un geste humain", () => {
      expect(executionNeedsApproval({ amount: 900_000 }, null)).toBe(false);
    });
  });

  describe('closureNeedsApproval', () => {
    it.each([
      [RefundStatus.COMPLETED, 49_999, false],
      [RefundStatus.COMPLETED, 50_000, true],
      [RefundStatus.COMPLETED, 50_001, true],
      // D-1 — refuser un remboursement important prive le client de son dû.
      [RefundStatus.REJECTED, 49_999, false],
      [RefundStatus.REJECTED, 50_000, true],
      [RefundStatus.REJECTED, 120_000, true],
      // Ni argent ni décision : « en cours » reste direct.
      [RefundStatus.PROCESSING, 120_000, false],
      [RefundStatus.PENDING, 120_000, false],
    ])('%s à %i FCFA → %s', (status, amount, expected) => {
      expect(closureNeedsApproval({ amount }, status)).toBe(expected);
    });
  });

  describe('refundClosurePayload', () => {
    const refund = { id: 'ref-1', amount: 80_000 };
    const hash = (payload: unknown) =>
      approvalPayloadHash('REFUND_EXECUTION', 'ref-1', payload);

    it("ne vaut pas pour un virement : l'empreinte diffère de celle d'une exécution", () => {
      expect(
        hash(refundClosurePayload(refund, RefundStatus.COMPLETED)),
      ).not.toBe(hash(refundApprovalPayload(refund)));
    });

    it('lie le statut visé : approuver « remboursé » n’autorise pas « refusé »', () => {
      expect(
        hash(refundClosurePayload(refund, RefundStatus.COMPLETED)),
      ).not.toBe(hash(refundClosurePayload(refund, RefundStatus.REJECTED)));
    });

    it('lie le montant et la note', () => {
      const base = refundClosurePayload(
        refund,
        RefundStatus.REJECTED,
        'Fraude',
      );
      expect(base).toEqual({
        refundId: 'ref-1',
        amountXaf: 80_000,
        closeAs: RefundStatus.REJECTED,
        notes: 'Fraude',
      });
      expect(
        hash(
          refundClosurePayload(
            { ...refund, amount: 80_001 },
            RefundStatus.REJECTED,
            'Fraude',
          ),
        ),
      ).not.toBe(hash(base));
      expect(
        hash(refundClosurePayload(refund, RefundStatus.REJECTED, 'Autre')),
      ).not.toBe(hash(base));
    });

    it('omet une note vide, pour que la demande et sa consommation aient la même empreinte', () => {
      // Le JSON stocké en base perd les clés `undefined` : une note absente
      // doit donc être absente des deux côtés, jamais `null` d'un seul.
      expect(
        refundClosurePayload(refund, RefundStatus.COMPLETED, '  '),
      ).toEqual({
        refundId: 'ref-1',
        amountXaf: 80_000,
        closeAs: RefundStatus.COMPLETED,
      });
    });
  });

  describe('closureFromPayload', () => {
    it('reconnaît une approbation de clôture, et elle seule', () => {
      expect(
        closureFromPayload({
          refundId: 'r',
          amountXaf: 1,
          closeAs: 'REJECTED',
          notes: 'x',
        }),
      ).toEqual({ closeAs: RefundStatus.REJECTED, notes: 'x' });
      expect(closureFromPayload({ refundId: 'r', amountXaf: 1 })).toBeNull();
      // Une valeur inattendue ne doit jamais devenir une clôture.
      expect(closureFromPayload({ closeAs: 'PENDING' })).toBeNull();
      expect(closureFromPayload(null)).toBeNull();
    });
  });
});
