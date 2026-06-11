/* eslint-disable prettier/prettier */
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MtnMomoTokenService } from './mtn-momo-token.service';
import { validateMtnPhoneNumber, formatMtnPhoneNumber } from './mtn-momo-phone.util';

export interface RequestToPayRequest {
  amount: string;
  currency: string;
  externalId: string;
  payer: {
    partyIdType: 'MSISDN';
    partyId: string;
  };
  payerMessage: string;
  payeeNote: string;
}

export interface TransactionStatus {
  financialTransactionId?: string;
  externalId: string;
  amount: string;
  currency: string;
  payer: {
    partyIdType: string;
    partyId: string;
  };
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  reason?: string;
}

/**
 * Client de paiement MTN MoMo (LIL-146).
 *
 * Service principal exposant l'API métier (requestToPay, statut, solde,
 * helpers téléphone, healthCheck). La connexion HTTP, les intercepteurs et le
 * cycle de vie du token sont délégués à MtnMomoTokenService ; les helpers
 * téléphone sont des fonctions pures dans mtn-momo-phone.util.
 */
@Injectable()
export class MtnMomoService {
  private readonly logger = new Logger(MtnMomoService.name);

  constructor(private readonly token: MtnMomoTokenService) {}

  // ===== Fonctionnalités de paiement =====

  async requestToPay(request: RequestToPayRequest): Promise<string> {
    if (!this.token.isReady) {
      await this.token.initialize();
    }

    const referenceId = randomUUID();

    try {
      this.logger.log(`Initiating payment request: ${referenceId}`);
      this.logger.log(`Amount: ${request.amount} ${request.currency}`);
      this.logger.log(`Payer: ${request.payer.partyId}`);
      // Obtenir un token valide (nouveau ou existant)
      const token = await this.token.getValidAccessToken();
      await this.token.client.post('/collection/v1_0/requesttopay', request, {
        headers: {
          'X-Reference-Id': referenceId,
          'X-Target-Environment': this.token.environment,
          'Ocp-Apim-Subscription-Key': this.token.subscriptionKey, // ⚠️ OBLIGATOIRE
          'Authorization': `Bearer ${token}`, // ⚠️ OBLIGATOIRE
          'Content-Type': 'application/json',
        },
      });

      this.logger.log(`✅ Payment request initiated: ${referenceId}`);
      return referenceId;

    } catch (error) {
      this.logger.error(`❌ Payment request failed: ${error.message}`);
      throw new HttpException(
        `Payment request failed: ${error.response?.data?.message || error.message}`,
        error.response?.status || HttpStatus.BAD_REQUEST
      );
    }
  }

  async getTransactionStatus(referenceId: string): Promise<TransactionStatus> {
    if (!this.token.isReady) {
      await this.token.initialize();
    }

    try {
      const response = await this.token.client.get<TransactionStatus>(
        `/collection/v1_0/requesttopay/${referenceId}`,
        {
          headers: {
            'X-Target-Environment': this.token.environment,
          },
        }
      );

      this.logger.log(`Transaction ${referenceId} status: ${response.data.status}`);
      return response.data;

    } catch (error) {
      this.logger.error(`❌ Failed to get transaction status: ${error.message}`);
      throw new HttpException(
        `Failed to get transaction status: ${error.message}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }

  async getAccountBalance(): Promise<{ availableBalance: string; currency: string }> {
    if (!this.token.isReady) {
      await this.token.initialize();
    }

    try {
      const response = await this.token.client.get('/collection/v1_0/account/balance', {
        headers: {
          'X-Target-Environment': this.token.environment,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to get account balance: ${error.message}`);
      throw new HttpException(
        `Failed to get account balance: ${error.message}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }

  // ===== Méthodes utilitaires =====

  validatePhoneNumber(phoneNumber: string, countryCode: string = '242'): boolean {
    return validateMtnPhoneNumber(phoneNumber, countryCode);
  }

  formatPhoneNumber(phoneNumber: string, countryCode: string = '242'): string {
    return formatMtnPhoneNumber(phoneNumber, countryCode);
  }

  // Méthode de santé pour vérifier l'état du service
  async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      if (!this.token.isReady) {
        return {
          status: 'not_initialized',
          details: {
            message: 'Service not yet initialized',
          },
        };
      }

      const balance = await this.getAccountBalance();

      return {
        status: 'healthy',
        details: {
          initialized: true,
          environment: this.token.environment,
          apiUser: this.token.apiUserId,
          tokenExpires: this.token.tokenExpiry,
          balance: balance,
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error.message,
        },
      };
    }
  }
}
