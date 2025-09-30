/* eslint-disable prettier/prettier */
export interface MtnMomoConfig {
  baseUrl: string;
  subscriptionKey: string;
  callbackUrl: string;
  environment: 'sandbox' | 'production';
}

export interface ApiUserResponse {
  referenceId: string;
}

export interface ApiKeyResponse {
  apiKey: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface RequestToPayRequest {
  amount: string;
  currency: string;
  externalId: string;
  payer: {
    partyIdType: 'MSISDN';
    partyId: string; // Numéro de téléphone
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

export interface PaymentWebhookPayload {
  referenceId: string;
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  financialTransactionId?: string;
  reason?: string;
}
