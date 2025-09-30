/* eslint-disable prettier/prettier */
import { Injectable, Logger, HttpException, HttpStatus, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

export interface MtnMomoConfig {
  baseUrl: string;
  collectionSubscriptionKey: string;
  disbursementSubscriptionKey?: string;
  callbackUrl: string;
  environment: 'sandbox';
}

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

@Injectable()
export class MtnMomoService implements OnModuleInit {
  private readonly logger = new Logger(MtnMomoService.name);
  private readonly httpClient: AxiosInstance;
  private readonly config: MtnMomoConfig;
  private apiUser: string;
  private apiKey: string;
  private accessToken: string;
  private tokenExpiresAt: Date;
  private isInitialized = false;

  constructor(private configService: ConfigService) {
    // Charger la configuration
    this.config = {
      baseUrl: this.configService.get<string>(
        'MTN_MOMO_BASE_URL',
        'https://sandbox.momodeveloper.mtn.com'
      ),
      collectionSubscriptionKey: this.configService.get<string>('MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY'),
      disbursementSubscriptionKey: this.configService.get<string>('MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY'),
      callbackUrl: this.configService.get<string>('MTN_MOMO_CALLBACK_URL'),
      environment:'sandbox',
    };

    // Valider la configuration
    this.validateConfig();

    // Créer le client HTTP
    this.httpClient = axios.create({
      baseURL: this.config.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  async onModuleInit() {
    // Initialiser automatiquement au démarrage du module
    try {
      await this.initialize();
    } catch (error) {
      this.logger.error('Failed to initialize MTN MoMo service on module init:', error.message);
      // Ne pas bloquer le démarrage de l'application
      // L'initialisation sera retentée lors du premier appel
    }
  }

  private validateConfig() {
    const errors: string[] = [];

    if (!this.config.collectionSubscriptionKey) {
      errors.push('MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY is required');
    }

    if (!this.config.callbackUrl) {
      errors.push('MTN_MOMO_CALLBACK_URL is required');
    }

    if (errors.length > 0) {
      this.logger.error('❌ MTN MoMo configuration errors:');
      errors.forEach(error => this.logger.error(`  - ${error}`));
      throw new Error('MTN MoMo configuration is invalid. Check your environment variables.');
    }

    this.logger.log('✅ MTN MoMo configuration validated');
    this.logger.log(`Environment: ${this.config.environment}`);
    this.logger.log(`Base URL: ${this.config.baseUrl}`);
    this.logger.log(`Subscription Key: ${this.config.collectionSubscriptionKey.substring(0, 10)}...`);
  }

  private setupInterceptors() {
    // Intercepteur pour ajouter la subscription key
    this.httpClient.interceptors.request.use(
      async (config) => {
        // Toujours ajouter la subscription key
        config.headers['Ocp-Apim-Subscription-Key'] = this.config.collectionSubscriptionKey;

        // Ajouter le token d'accès si nécessaire
        if (this.shouldAddAuthHeader(config.url)) {
          if (!this.isInitialized) {
            await this.initialize();
          }
          const token = await this.getValidAccessToken();
          config.headers['Authorization'] = `Bearer ${token}`;
        }

        // Logs de debug
        this.logger.debug(`Request: ${config.method?.toUpperCase()} ${config.url}`);
        this.logger.debug(`Headers: ${JSON.stringify(config.headers, null, 2)}`);

        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Intercepteur pour gérer les erreurs
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug(`Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        const url = error.config?.url;

        this.logger.error(`❌ MTN MoMo API Error:`);
        this.logger.error(`  URL: ${url}`);
        this.logger.error(`  Status: ${status}`);
        this.logger.error(`  Message: ${message}`);

        // Messages d'erreur personnalisés
        if (status === 401) {
          if (message.includes('subscription key')) {
            this.logger.error('  💡 Solution: Verify your MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY in .env');
            this.logger.error('  💡 Make sure you have subscribed to Collections on https://momodeveloper.mtn.com');
          } else if (message.includes('token')) {
            this.logger.error('  💡 Solution: Token may be expired, will retry with new token');
          }
        } else if (status === 404) {
          this.logger.error('  💡 Solution: Check if the API endpoint exists for your environment');
        }

        return Promise.reject(error);
      }
    );
  }

  private shouldAddAuthHeader(url: string): boolean {
    return !url?.includes('/apiuser') && !url?.includes('/token');
  }

  // ===== Initialisation =====

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.log('MTN MoMo service already initialized');
      return;
    }

    try {
      this.logger.log('🔄 Initializing MTN Mobile Money service...');

      if (this.config.environment === 'sandbox') {
        // En sandbox, créer l'API user et la clé
        await this.createApiUser();
        await this.createApiKey();
      } else {
        // En production, utiliser les credentials fournis
        this.apiUser = this.configService.get<string>('MTN_MOMO_API_USER');
        this.apiKey = this.configService.get<string>('MTN_MOMO_API_KEY');

        if (!this.apiUser || !this.apiKey) {
          throw new Error('Production credentials (MTN_MOMO_API_USER and MTN_MOMO_API_KEY) are required');
        }
      }

      await this.generateAccessToken();
      
      this.isInitialized = true;
      this.logger.log('✅ MTN Mobile Money service initialized successfully');
      
      // Log des informations d'initialisation
      this.logger.log(`API User: ${this.apiUser}`);
      this.logger.log(`Token expires at: ${this.tokenExpiresAt}`);
      
    } catch (error) {
      this.logger.error('❌ Failed to initialize MTN Mobile Money service:', error.message);
      throw error;
    }
  }

  private async createApiUser(): Promise<void> {
    const referenceId = uuidv4();
    this.logger.log(`Creating API user with reference: ${referenceId}`);

    try {
      const response = await this.httpClient.post(
        '/v1_0/apiuser',
        {
          providerCallbackHost: this.config.callbackUrl,
        },
        {
          headers: {
            'X-Reference-Id': referenceId,
          },
        }
      );

      this.logger.log(`API user creation response: ${response.status}`);

      // Attendre un peu pour que l'utilisateur soit créé
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Vérifier que l'utilisateur a été créé
      const userResponse = await this.httpClient.get(`/v1_0/apiuser/${referenceId}`);
      if (userResponse.status !== 200) {
        throw new Error('API user verification failed after creation');
      }
      
      this.apiUser = referenceId;
      this.logger.log(`✅ API user created and verified: ${referenceId}`);
      
    } catch (error) {
      if (error.response?.status === 401) {
        throw new HttpException(
          'Invalid subscription key. Please check MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY in your .env file and ensure you have subscribed to Collections on https://momodeveloper.mtn.com',
          HttpStatus.UNAUTHORIZED
        );
      }
      throw new HttpException(
        `Failed to create API user: ${error.message}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }

  private async createApiKey(): Promise<void> {
    try {
      this.logger.log('Creating API key...');
      
      const response = await this.httpClient.post(`/v1_0/apiuser/${this.apiUser}/apikey`);
      
      this.apiKey = response.data.apiKey;
      this.logger.log(`✅ API key created: ${this.apiKey.substring(0, 10)}...`);
      
    } catch (error) {
      throw new HttpException(
        `Failed to create API key: ${error.message}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }

  private async generateAccessToken(): Promise<void> {
    try {
      this.logger.log('Generating access token...');
      
      const credentials = Buffer.from(`${this.apiUser}:${this.apiKey}`).toString('base64');
      
      const response = await this.httpClient.post(
        '/collection/token/',
        {},
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = new Date(Date.now() + (response.data.expires_in * 1000));
      
      this.logger.log('✅ Access token generated successfully');
      this.logger.log(`Token expires in: ${response.data.expires_in} seconds`);
      
    } catch (error) {
      throw new HttpException(
        `Failed to generate access token: ${error.message}`,
        HttpStatus.UNAUTHORIZED
      );
    }
  }

  private async getValidAccessToken(): Promise<string> {
    const now = new Date();
    const bufferTime = 5 * 60 * 1000; // 5 minutes avant expiration

    if (!this.accessToken || now.getTime() >= (this.tokenExpiresAt.getTime() - bufferTime)) {
      this.logger.log('Access token expired or about to expire, refreshing...');
      await this.generateAccessToken();
    }

    return this.accessToken;
  }

  // ===== Fonctionnalités de paiement =====

  async requestToPay(request: RequestToPayRequest): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const referenceId = uuidv4();

    try {
      this.logger.log(`Initiating payment request: ${referenceId}`);
      this.logger.log(`Amount: ${request.amount} ${request.currency}`);
      this.logger.log(`Payer: ${request.payer.partyId}`);

      await this.httpClient.post('/collection/v1_0/requesttopay', request, {
        headers: {
          'X-Reference-Id': referenceId,
          'X-Target-Environment': this.config.environment,
          'Ocp-Apim-Subscription-Key': this.config.collectionSubscriptionKey, // ⚠️ OBLIGATOIRE
          'Authorization': `Bearer ${this.accessToken}`, // ⚠️ OBLIGATOIRE
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
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const response = await this.httpClient.get<TransactionStatus>(
        `/collection/v1_0/requesttopay/${referenceId}`,
        {
          headers: {
            'X-Target-Environment': this.config.environment,
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
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const response = await this.httpClient.get('/collection/v1_0/account/balance', {
        headers: {
          'X-Target-Environment': this.config.environment,
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
    const cleaned = phoneNumber.replace(/\s+/g, '');
    
    // Patterns pour différents pays (ajoutez selon vos besoins)
    const patterns: Record<string, RegExp> = {
      '237': /^(237)?[67][0-9]{8}$/, // Cameroun
      '225': /^(225)?[0-9]{10}$/, // Côte d'Ivoire
      '243': /^(243)?[89][0-9]{8}$/, // RDC
      '242': /^(242)?[0-9]{9}$/, // Congo-Brazzaville
    };

    const pattern = patterns[countryCode] || /^[0-9]{9,15}$/;
    return pattern.test(cleaned);
  }

  formatPhoneNumber(phoneNumber: string, countryCode: string = '242'): string {
    let formatted = phoneNumber.replace(/\s+/g, '').replace(/^\+/, '');
    
    if (!formatted.startsWith(countryCode)) {
      formatted = countryCode + formatted;
    }
    
    return formatted;
  }

  // Méthode de santé pour vérifier l'état du service
  async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      if (!this.isInitialized) {
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
          environment: this.config.environment,
          apiUser: this.apiUser,
          tokenExpires: this.tokenExpiresAt,
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