import {
  bullets,
  callout,
  code,
  h2,
  h3,
  p,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 3 — Application Client (lilia-app).
 */
export function buildClientAppSection(): PageDef {
  return {
    title: '3. Application Client',
    icon: '🛒',
    children: [
      p('App Flutter client final — découverte restaurants, commande, suivi temps réel.'),
      h2('Stack'),
      ...bullets([
        'Flutter 3.41+',
        'Riverpod (code generation @riverpod)',
        'Firebase Auth',
        'Socket.io client (tracking)',
      ]),
      h2('Architecture feature-first'),
      code(
`lib/features/<nom>/
├── data/          # repositories — appels HTTP
├── application/   # controllers Riverpod
├── presentation/  # screens + widgets
└── domain/        # entités si besoin local`,
        'plain text',
      ),
      h2('Conventions Riverpod'),
      ...bullets([
        '@riverpod sur tous les controllers/providers',
        'build_runner après chaque ajout/modif @riverpod',
        'AsyncValue pour les états réseau',
        'KeepAlive si nécessaire (cache long-lived)',
      ]),
      h2('Sous-pages'),
      ...bullets([
        'Onboarding & Auth',
        'Browsing restaurants',
        'Cart & Checkout',
        'Tracking live',
        'Notifications',
        'Reviews',
        'Favorites',
        'Payments',
        'Wallet (futur)',
        'Referral (futur)',
      ]),
    ],
    subPages: [
      onboardingPage(),
      browsingPage(),
      cartCheckoutPage(),
      trackingPage(),
      paymentsClientPage(),
      futurePage(),
    ],
  };
}

function onboardingPage(): PageDef {
  return {
    title: 'Onboarding & Auth',
    icon: '🚪',
    children: [
      h2('Flux'),
      ...bullets([
        'Splash → choix login phone ou email Firebase',
        'OTP / email verification Firebase',
        'POST /users/sync (avec referralCode si deep link)',
        'Récupération adresse (POST /adresses) + permission géoloc',
      ]),
      callout(
        'Le referralCode du parrain est passé en query string du deep link. Le backend crédite +500 pts au parrain à la 1ère commande livrée du filleul.',
        '🎁',
        'green_background',
      ),
    ],
  };
}

function browsingPage(): PageDef {
  return {
    title: 'Browsing restaurants',
    icon: '🔍',
    children: [
      h2('Endpoints'),
      ...bullets([
        'GET /restaurants?quartierId&search&isOpen',
        'GET /restaurants/:id (avec horaires + averageRating)',
        'GET /restaurants/:id/menus',
        'GET /restaurants/:id/products',
        'GET /banners',
      ]),
      h2('UX'),
      ...bullets([
        'Liste filtrée par quartier de livraison',
        'Badge "Fermé" si isOpen=false',
        'ETA affiché : estimatedDeliveryTimeMin–Max',
        'Tri par moyenne, popularité, proximité',
      ]),
    ],
  };
}

function cartCheckoutPage(): PageDef {
  return {
    title: 'Cart & Checkout',
    icon: '🛍️',
    children: [
      h2('Cart'),
      ...bullets([
        'Un seul restaurant par panier (warning si on tente de mixer)',
        'CartItem snapshot du prix au moment de l\'ajout',
        'POST /cart/items, PATCH /cart/items/:id, DELETE /cart/items/:id',
      ]),
      h2('Checkout'),
      ...bullets([
        'Header idempotency-key obligatoire (UUID v4 généré côté client)',
        'POST /orders/checkout avec : adresseId, paymentMethod, promoCode?, useLoyaltyPoints?',
        'OrderValidator vérifie stock + resto ouvert',
        'OrderCalculator applique 8% serviceFee + promo + loyalty',
      ]),
      callout(
        'Idempotency-key : sans elle, double-tap = 2 commandes créées. Toujours générer un UUID au montage de l\'écran checkout.',
        '⚠️',
        'red_background',
      ),
    ],
  };
}

function trackingPage(): PageDef {
  return {
    title: 'Tracking live',
    icon: '📍',
    children: [
      h2('Flux'),
      ...bullets([
        'Socket.io connect avec Firebase ID token dans handshake.auth.token',
        'emit("order:watch", { orderId })',
        'Écoute "driver:position" {lat, lng, eta, timestamp}',
        'Écoute "order:status" {status}',
        'Fallback HTTP polling GET /deliveries/by-order/:orderId toutes les 30s',
      ]),
      h2('Affichage carte'),
      ...bullets([
        'Marker livreur animé (interpolation lat/lng)',
        '"Arrive dans X min" basé sur eta',
        'Polyline route restaurant → adresse client (Google Maps)',
      ]),
    ],
  };
}

function paymentsClientPage(): PageDef {
  return {
    title: 'Payments (Client)',
    icon: '💳',
    children: [
      h2('Modes supportés'),
      ...bullets(['MTN_MOMO', 'AIRTEL_MONEY']),
      h2('Mode MANUAL (par défaut prod)'),
      ...bullets([
        'POST /payments → response contient instructions de virement',
        'Client vire sur LILIA_PAYMENT_PHONE',
        'Admin confirme dans le dashboard → notif "Paiement confirmé"',
      ]),
    ],
  };
}

function futurePage(): PageDef {
  return {
    title: 'Wallet & Referral (futur)',
    icon: '🔮',
    children: [
      h2('Roadmap'),
      ...bullets([
        'Wallet : stocker un solde XAF rechargeable par MTN MoMo',
        'Programme parrainage v2 : palier de paliers (5 / 10 / 25 filleuls)',
        'Bons cadeaux',
      ]),
      callout(
        'Voir section 8. Roadmap produit pour la priorisation.',
        '📌',
      ),
    ],
  };
}
