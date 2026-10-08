import { ConflictException } from '@nestjs/common';
import { RefundStatus } from '@prisma/client';

import { approvalPayloadHash } from '../approvals/approval-rules';
import { RefundsController } from './refunds.controller';

/**
 * R-01 — le contrôleur traduit le refus `APPROVAL_REQUIRED` du service en
 * demande d'approbation, avec la forme de réponse des autres gestes à deux
 * (`{ data: { approvalRequired, approval }, message }`). Toute autre erreur
 * remonte telle quelle : une demande ne doit jamais naître d'un geste que le
 * serveur refuse pour une autre raison.
 */
describe('RefundsController — R-01', () => {
  const admin = { id: 'admin-a' } as never;
  let refunds: { updateStatus: jest.Mock; findOne: jest.Mock };
  let execution: { execute: jest.Mock };
  let approvals: { request: jest.Mock };
  let audit: { record: jest.Mock };
  let controller: RefundsController;

  const refund = {
    id: 'r-1',
    orderId: 'order-abcdef123456',
    amount: 80_000,
    status: RefundStatus.PENDING,
  };

  beforeEach(() => {
    refunds = {
      updateStatus: jest.fn(),
      findOne: jest.fn().mockResolvedValue({ data: refund }),
    };
    execution = { execute: jest.fn() };
    approvals = { request: jest.fn().mockResolvedValue({ id: 'ap-1' }) };
    audit = { record: jest.fn() };
    controller = new RefundsController(
      refunds as never,
      execution as never,
      audit as never,
      approvals as never,
    );
  });

  describe('PATCH /refunds/:id/status', () => {
    it('sous le seuil : la réponse du service, inchangée', async () => {
      refunds.updateStatus.mockResolvedValue({ data: { id: 'r-1' } });
      await expect(
        controller.updateStatus(
          'r-1',
          { status: RefundStatus.COMPLETED },
          admin,
        ),
      ).resolves.toEqual({ data: { id: 'r-1' } });
      expect(approvals.request).not.toHaveBeenCalled();
    });

    it('au-delà du seuil : ouvre la demande pour CE statut et CETTE note, rien n’est clôturé', async () => {
      refunds.updateStatus.mockRejectedValue(
        new ConflictException({ message: 'x', code: 'APPROVAL_REQUIRED' }),
      );

      const res = await controller.updateStatus(
        'r-1',
        { status: RefundStatus.REJECTED, notes: 'Doublon' },
        admin,
      );

      expect(res).toEqual({
        data: { approvalRequired: true, approval: { id: 'ap-1' } },
        message: expect.stringContaining('second administrateur'),
      });
      const request = approvals.request.mock.calls[0][0];
      expect(request).toMatchObject({
        kind: 'REFUND_EXECUTION',
        refId: 'r-1',
        amountXaf: 80_000,
        requestedBy: 'admin-a',
        payload: {
          refundId: 'r-1',
          amountXaf: 80_000,
          closeAs: RefundStatus.REJECTED,
          notes: 'Doublon',
        },
      });
      // La demande ne vaut pas un virement : son empreinte est distincte.
      expect(
        approvalPayloadHash('REFUND_EXECUTION', 'r-1', request.payload),
      ).not.toBe(
        approvalPayloadHash('REFUND_EXECUTION', 'r-1', {
          refundId: 'r-1',
          amountXaf: 80_000,
        }),
      );
    });

    it.each(['REFUND_PROVIDER_IN_FLIGHT', undefined])(
      'un autre refus (%s) remonte tel quel, sans demande',
      async (code) => {
        const error = new ConflictException(
          code
            ? { message: 'x', code }
            : 'Ce remboursement est déjà clos (COMPLETED).',
        );
        refunds.updateStatus.mockRejectedValue(error);
        await expect(
          controller.updateStatus(
            'r-1',
            { status: RefundStatus.COMPLETED },
            admin,
          ),
        ).rejects.toBe(error);
        expect(approvals.request).not.toHaveBeenCalled();
      },
    );
  });

  describe('POST /refunds/:id/execute', () => {
    it('au-delà du seuil : demande de VIREMENT (sans closeAs), aucun virement', async () => {
      const res = await controller.execute('r-1', admin);
      expect(res).toMatchObject({
        approvalRequired: true,
        approval: { id: 'ap-1' },
      });
      expect(approvals.request.mock.calls[0][0].payload).toEqual({
        refundId: 'r-1',
        amountXaf: 80_000,
      });
      expect(execution.execute).not.toHaveBeenCalled();
    });

    it('un remboursement qui n’est plus en attente : 409, aucune demande inutile', async () => {
      refunds.findOne.mockResolvedValue({
        data: { ...refund, status: RefundStatus.COMPLETED },
      });
      await expect(controller.execute('r-1', admin)).rejects.toThrow(
        ConflictException,
      );
      expect(approvals.request).not.toHaveBeenCalled();
    });

    it('sous le seuil : virement direct', async () => {
      refunds.findOne.mockResolvedValue({
        data: { ...refund, amount: 49_999 },
      });
      execution.execute.mockResolvedValue({ status: 'PROCESSING' });
      await controller.execute('r-1', admin);
      expect(execution.execute).toHaveBeenCalledWith('r-1', 'admin-a');
      expect(approvals.request).not.toHaveBeenCalled();
    });
  });
});
