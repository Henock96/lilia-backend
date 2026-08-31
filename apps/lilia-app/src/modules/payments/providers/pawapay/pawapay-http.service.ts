import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';

import { ProviderUnavailableError } from '../payment-provider.interface';
import { PawaPayActiveConf } from './pawapay.types';

/**
 * Transport HTTP vers l'API pawaPay : URL de base, jeton, délais, et
 * traduction des pannes réseau en `ProviderUnavailableError`.
 *
 * Isolé du provider métier pour la même raison que `MtnMomoTokenService` l'est
 * de `MtnMomoService` (convention LIL-134) : le provider décrit *ce qu'on
 * demande au prestataire*, ce service *comment on lui parle*.
 *
 * L'authentification est un simple jeton porteur — pas de cycle de vie à gérer,
 * contrairement à MTN MoMo dont le token expire toutes les heures.
 */
@Injectable()
export class PawaPayHttpService implements OnModuleInit {
  private readonly logger = new Logger(PawaPayHttpService.name);
  private client: AxiosInstance | null = null;

  /** Configuration active du compte marchand, mise en cache. */
  private activeConf: PawaPayActiveConf | null = null;
  private activeConfExpiry = 0;
  private static readonly ACTIVE_CONF_TTL_MS = 15 * 60_000;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const baseURL = this.config.get<string>('PAWAPAY_API_URL');
    const token = this.config.get<string>('PAWAPAY_API_TOKEN');

    if (!baseURL || !token) {
      // Pas une erreur : le service n'est instancié que si le module de
      // paiement est chargé, mais il ne sert que si `PAYMENT_MODE=PAWAPAY`.
      // Le schéma Joi rend ces variables obligatoires dans ce mode-là — donc
      // si on passe ici, c'est qu'on tourne en MANUAL ou en MTN.
      this.logger.log(
        'pawaPay non configuré (PAWAPAY_API_URL / PAWAPAY_API_TOKEN absents) — provider inactif',
      );
      return;
    }

    this.client = axios.create({
      baseURL: baseURL.replace(/\/+$/, ''),
      // 15 s : au-delà, on préfère laisser le client réessayer (l'appel est
      // idempotent) plutôt que de garder une requête HTTP ouverte pendant que
      // l'utilisateur attend devant son téléphone.
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // On veut lire les corps d'erreur 4xx nous-mêmes (ils portent
      // `failureReason`), sans qu'axios lève avant.
      validateStatus: (status) => status < 500,
    });

    this.logger.log(`pawaPay configuré — ${baseURL}`);
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): AxiosInstance {
    if (!this.client) {
      throw new ProviderUnavailableError(
        'pawaPay n’est pas configuré sur ce serveur.',
      );
    }
    return this.client;
  }

  /**
   * POST vers pawaPay.
   *
   * Les 5xx et les erreurs réseau lèvent `ProviderUnavailableError` : l'appelant
   * laisse alors la transaction en attente et le rejeu est sûr, puisqu'il
   * repartira avec le même identifiant (pawaPay répondra `DUPLICATE_IGNORED`).
   *
   * Les 2xx et 4xx sont rendus tels quels : un 400 porte un `failureReason`
   * exploitable, c'est un refus métier et non une panne.
   */
  async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; data: T }> {
    const client = this.requireClient();
    try {
      const res = await client.post<T>(path, body, { headers: extraHeaders });
      return { status: res.status, data: res.data };
    } catch (error) {
      throw this.toUnavailable(error, `POST ${path}`);
    }
  }

  /** GET vers pawaPay. Un 404 est rendu tel quel (transaction inconnue). */
  async get<T>(path: string): Promise<{ status: number; data: T }> {
    const client = this.requireClient();
    try {
      const res = await client.get<T>(path);
      return { status: res.status, data: res.data };
    } catch (error) {
      throw this.toUnavailable(error, `GET ${path}`);
    }
  }

  /**
   * Configuration active du compte marchand : pays, opérateurs et devises
   * réellement ouverts, avec leur disponibilité du moment.
   *
   * C'est la **seule source de vérité** sur les codes opérateur (`MTN_MOMO_COG`,
   * `AIRTEL_COG`…) : ils dépendent du compte marchand et ne figurent dans
   * aucune énumération publique de la documentation. Les variables
   * d'environnement en donnent une valeur de repli, cette route les confirme.
   *
   * Mise en cache 15 minutes : elle sert à griser un opérateur en panne dans
   * l'application, pas à décider d'une transaction.
   */
  async getActiveConfiguration(): Promise<PawaPayActiveConf | null> {
    if (!this.isConfigured) return null;
    if (this.activeConf && Date.now() < this.activeConfExpiry) {
      return this.activeConf;
    }
    try {
      const { status, data } =
        await this.get<PawaPayActiveConf>('/v2/active-conf');
      if (status !== 200) return this.activeConf;
      this.activeConf = data;
      this.activeConfExpiry =
        Date.now() + PawaPayHttpService.ACTIVE_CONF_TTL_MS;
      return data;
    } catch (error) {
      // Dégradation volontaire : ne pas pouvoir afficher la liste des
      // opérateurs ne doit pas empêcher de payer.
      this.logger.warn(
        `Configuration active pawaPay indisponible : ${(error as Error).message}`,
      );
      return this.activeConf;
    }
  }

  /**
   * Traduit une erreur axios en `ProviderUnavailableError`, **sans jamais
   * propager le corps de la réponse du prestataire** : il peut contenir des
   * identifiants d'appel et le numéro du payeur, et `HttpExceptionFilter` le
   * renverrait tel quel au client (même défaut que le fix M14 sur MTN).
   */
  private toUnavailable(error: unknown, context: string): Error {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    this.logger.error(
      `pawaPay ${context} — statut: ${status ?? 'n/a'}, code: ${axiosError.code ?? 'n/a'}`,
    );
    return new ProviderUnavailableError(
      'Le service de paiement est momentanément indisponible. Réessayez dans un instant.',
      status,
    );
  }
}
