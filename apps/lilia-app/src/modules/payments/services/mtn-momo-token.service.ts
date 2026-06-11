/* eslint-disable prettier/prettier */
import { Injectable, Logger, HttpException, HttpStatus, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';

export interface MtnMomoConfig {
  baseUrl: string;
  collectionSubscriptionKey: string;
  disbursementSubscriptionKey?: string;
  callbackUrl: string;
  environment: 'sandbox' | 'production';
}

/**
 * Gestion de la connexion MTN MoMo (extrait de MtnMomoService — LIL-146).
 *
 * Possède le client HTTP (axios) partagé, ses intercepteurs, la configuration,
 * le provisioning sandbox (API user/key) et le cycle de vie du token d'accès.
 * MtnMomoService consomme ce service via `client` + `getValidAccessToken()`.
 */
@Injectable()
export class MtnMomoTokenService implements OnModuleInit {
  private readonly logger = new Logger(MtnMomoTokenService.name);
  private readonly httpClient: AxiosInstance;
  private readonly config: MtnMomoConfig;
  private readonly paymentMode: string;
  private apiUser: string;
  private apiKey: string;
  private accessToken: string;
  private tokenExpiresAt: Date;
  private isInitialized = false;

  constructor(private configService: ConfigService) {
    this.paymentMode = this.configService.get<string>('PAYMENT_MODE', 'MANUAL');
    // Charger la configuration
    this.config = {
      baseUrl: this.configService.get<string>(
        'MTN_MOMO_BASE_URL',
        'https://sandbox.momodeveloper.mtn.com'
      ),
      collectionSubscriptionKey: this.configService.get<string>('MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY'),
      disbursementSubscriptionKey: this.configService.get<string>('MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY'),
      callbackUrl: this.configService.get<string>('MTN_MOMO_CALLBACK_URL'),
      environment: this.paymentMode === 'MTN_PRODUCTION' ? 'production' : 'sandbox',
    };

    // Valider la configuration
    if (this.paymentMode !== 'MANUAL') {
      this.validateConfig();
    }

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

  // ===== Accès partagé pour MtnMomoService =====

  /** Client HTTP axios (intercepteurs auth déjà branchés). */
  get client(): AxiosInstance {
    return this.httpClient;
  }

  get isReady(): boolean {
    return this.isInitialized;
  }

  get environment(): 'sandbox' | 'production' {
    return this.config.environment;
  }

  get subscriptionKey(): string {
    return this.config.collectionSubscriptionKey;
  }

  get apiUserId(): string {
    return this.apiUser;
  }

  get tokenExpiry(): Date {
    return this.tokenExpiresAt;
  }

  async onModuleInit() {
    if (this.paymentMode === 'MANUAL') {
      this.logger.log('MTN MoMo en mode MANUAL: initialisation API ignorée');
      return;
    }
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
    const referenceId = randomUUID();
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

  async getValidAccessToken(): Promise<string> {
    const now = new Date();
    const bufferTime = 5 * 60 * 1000; // 5 minutes avant expiration

    if (!this.accessToken || now.getTime() >= (this.tokenExpiresAt.getTime() - bufferTime)) {
      this.logger.log('Access token expired or about to expire, refreshing...');
      await this.generateAccessToken();
    }

    return this.accessToken;
  }
}
