import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Prévient le site public qu'une carte a changé.
 *
 * ## Le problème que ce service résout
 *
 * La page vendeur de `apps/web` est mise en cache (`'use cache'` +
 * `cacheTag('vendor-<id>')` + `cacheLife('minutes')`). Une **Server Action**
 * n'invalide que le cache de *son propre* déploiement : l'administration est
 * une application Next distincte, elle ne peut donc pas purger celui du site.
 * Sans ce rappel, un prix modifié attend l'expiration du cache.
 *
 * ## Pourquoi c'est du « au mieux », et pourquoi c'est le bon choix
 *
 * L'appel est **fire-and-forget** : hors transaction, sans attente, sans
 * relance, et il n'échoue jamais vers l'appelant. Enregistrer un produit ne doit
 * pas dépendre de la joignabilité du site — ce serait faire tomber l'écriture
 * pour un cache.
 *
 * Le repli est déjà en place et suffit : `cacheLife('minutes')` borne la
 * péremption. Une invalidation perdue coûte quelques minutes de retard, pas une
 * incohérence durable. C'est précisément pourquoi on **n'utilise pas** l'outbox
 * (`OutboxEvent`), qui existe pour ce qui doit être garanti — la notification de
 * commande au vendeur. Y mettre une purge de cache reviendrait à payer une
 * garantie transactionnelle pour une donnée qui périme toute seule.
 *
 * ## Configuration
 *
 * Deux variables, et **les deux** sont nécessaires. Si l'une manque, le service
 * se tait définitivement au lieu d'échouer à chaque écriture : le mode
 * « non configuré » est légitime (développement local, préproduction sans site).
 * Il est journalisé une fois au démarrage, pas à chaque appel.
 *
 * ⚠️ `WEB_REVALIDATE_SECRET` protège une route publique du site. Sans lui,
 * n'importe qui pourrait purger le cache en boucle et transformer le site en
 * amplificateur de charge vers ce backend.
 */
@Injectable()
export class CatalogRevalidationService {
  private readonly logger = new Logger(CatalogRevalidationService.name);

  private readonly endpoint?: string;
  private readonly secret?: string;

  /** Coupe un site injoignable plutôt que de retenir une requête sortante. */
  private static readonly TIMEOUT_MS = 3000;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('WEB_REVALIDATE_URL');
    this.secret = config.get<string>('WEB_REVALIDATE_SECRET');

    if (!this.enabled) {
      this.logger.log(
        'Revalidation du site désactivée (WEB_REVALIDATE_URL / ' +
          'WEB_REVALIDATE_SECRET absents) — le cache public expirera de ' +
          'lui-même au bout de quelques minutes.',
      );
    }
  }

  private get enabled(): boolean {
    return Boolean(this.endpoint && this.secret);
  }

  /**
   * Demande au site d'oublier la carte d'un vendeur.
   *
   * Ne renvoie rien et ne rejette jamais : l'appelant est un chemin d'écriture,
   * il n'a pas à savoir si le site a répondu.
   */
  revalidateVendor(restaurantId: string, reason: string): void {
    if (!this.enabled) return;
    void this.post(restaurantId, reason);
  }

  private async post(restaurantId: string, reason: string): Promise<void> {
    try {
      const res = await fetch(this.endpoint!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // En-tête dédié plutôt que `Authorization` : ce n'est pas une
          // identité, c'est un secret partagé entre deux de nos services.
          'x-revalidate-secret': this.secret!,
        },
        body: JSON.stringify({ restaurantId, reason }),
        signal: AbortSignal.timeout(CatalogRevalidationService.TIMEOUT_MS),
      });

      if (!res.ok) {
        // `warn` et non `error` : le site est peut-être en cours de
        // déploiement, et le cache expirera quand même.
        this.logger.warn(
          `Revalidation refusée par le site (${res.status}) — vendeur ${restaurantId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Revalidation injoignable pour le vendeur ${restaurantId} : ` +
          (error instanceof Error ? error.message : 'erreur inconnue'),
      );
    }
  }
}
