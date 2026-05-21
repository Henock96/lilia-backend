import {
  bullets,
  callout,
  code,
  divider,
  h2,
  h3,
  numbered,
  p,
  quote,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 5 — Restaurants.
 * Inclut une page "Pitch restaurant" commerciale + un process d'onboarding détaillé.
 */
export function buildRestaurantsSection(): PageDef {
  return {
    title: '5. Restaurants',
    icon: '🍽️',
    children: [
      p(
        'Documentation côté restaurateur : pourquoi rejoindre Lilia Food, comment être onboardé, comment opérer au quotidien.',
      ),
      h2('Sous-pages'),
      ...bullets([
        'Pitch restaurant (page commerciale)',
        'Process onboarding restaurant',
        'Dashboard restaurant (opérations quotidiennes)',
        'SLA & qualité',
      ]),
    ],
    subPages: [
      pitchRestaurantPage(),
      onboardingRestaurantPage(),
      restaurantDashboardPage(),
      slaPage(),
    ],
  };
}

function pitchRestaurantPage(): PageDef {
  return {
    title: 'Pitch Restaurant — Pourquoi rejoindre Lilia Food',
    icon: '🚀',
    children: [
      callout(
        'Document à présenter aux restaurateurs prospects. Version "élévateur" — adapter selon le segment (gargote, restaurant haut de gamme, fast-food).',
        '🎯',
        'green_background',
      ),

      h2('Lilia Food en 1 minute'),
      p(
        'Lilia Food est la première plateforme de livraison de repas dédiée à Brazzaville. Nous connectons les restaurants locaux à une base de clients exigeants, gérons la logistique, et vous permettons de vous concentrer sur ce que vous faites de mieux : la cuisine.',
      ),

      h2('Pourquoi rejoindre Lilia Food ?'),
      ...bullets([
        '📈 Acquisition clients : accédez à des milliers de Brazzavillois actifs sur l\'app',
        '👁️ Visibilité : votre restaurant en home, en categories tendances, push notifications',
        '🛵 Logistique gérée : nous fournissons les livreurs, vous ne gérez plus rien',
        '💸 Paiement sécurisé : MTN MoMo + Airtel — encaissement automatique',
        '📊 Analytics : tableau de bord temps réel des ventes, top plats, pics horaires',
        '🤝 Support dédié : équipe humaine joignable 7j/7 pour les incidents',
        '🚀 Croissance : nous investissons dans la marque, vous bénéficiez de l\'effet réseau',
      ]),

      h2('Acquisition clients'),
      p(
        'Lilia Food est en hyper-croissance à Brazzaville. Vous bénéficiez immédiatement de notre base utilisateurs sans avoir à investir dans la publicité.',
      ),
      ...bullets([
        'Campagnes marketing locales financées par nous (radio, panneaux, social media)',
        'Programme parrainage : chaque nouveau client coûté par un autre client',
        'Push notifications ciblées : nouveau menu, promo, plat spécial',
        'Programme fidélité automatique : 1 pt par 100 XAF dépensés',
      ]),

      h2('Visibilité dans l\'app'),
      ...bullets([
        'Présence dans la home filtrée par quartier de livraison',
        'Bannières premium (slots payants — option)',
        'Mise en avant lors de nouveau menu / plat du jour',
        'Section "Coups de cœur Brazzaville" éditorialisée',
      ]),

      h2('Logistique sans effort'),
      p(
        'Vous préparez. Nous livrons. Notre flotte de livreurs partenaires est notée, formée, géolocalisée. ETA temps réel sur la commande.',
      ),
      ...bullets([
        'Auto-assignation d\'un livreur dès que la commande est PRÊTE',
        'Position GPS du livreur partagée avec le client (et avec vous)',
        'Bouton "Incident" si problème de livraison — équipe Ops prend le relais',
      ]),

      h2('Paiements & encaissement'),
      ...bullets([
        'Le client paie via MTN MoMo ou Airtel Money',
        'Les fonds sont collectés par Lilia Food',
        'Versement hebdomadaire sur votre compte (jour fixe à définir)',
        'Commission Lilia : transparente (% à négocier au contrat)',
        'Aucun frais d\'inscription, aucun abonnement mensuel',
      ]),

      h2('Analytics & insights'),
      ...bullets([
        'Tableau de bord temps réel : commandes du jour, CA, top plats',
        'Historique 30 / 90 jours / 1 an',
        'Heures de pointe : optimisez vos plannings cuisine',
        'Taux d\'annulation : identifiez les frictions',
      ]),

      h2('Support'),
      p(
        'Une équipe Ops humaine basée à Brazzaville, joignable directement. Pas de chatbot, pas de robotisation. Vraies personnes, vraies solutions.',
      ),

      h2('Croissance'),
      quote(
        'Nous ne sommes pas une app de livraison de plus. Nous construisons l\'infrastructure du quotidien congolais.',
      ),
      ...bullets([
        'Roadmap publique partagée (cette page, section 8)',
        'Co-construction des features avec les restaurants pilotes',
        'Plan d\'expansion vers Pointe-Noire, Dolisie (Q4 2026)',
      ]),

      divider(),
      h2('Prochaine étape'),
      ...bullets([
        '👉 Voir la page "Process onboarding restaurant"',
        '📞 Contact : équipe partenariats Lilia Food',
      ]),
    ],
  };
}

function onboardingRestaurantPage(): PageDef {
  return {
    title: 'Process onboarding restaurant',
    icon: '✅',
    children: [
      h2('Étapes'),
      ...numberedSteps([
        'Premier contact + visite du restaurant',
        'Signature du contrat (commission, fréquence de versement)',
        'Création du compte RESTAURATEUR (POST /admin/users + role RESTAURATEUR)',
        'Création du restaurant (POST /admin/restaurants avec ownerId)',
        'Saisie des horaires d\'ouverture (OperatingHours)',
        'Définition des zones de livraison + tarifs (FIXED ou ZONE_BASED)',
        'Création des catégories de menu',
        'Saisie des produits + variants + stocks quotidiens',
        'Photos pro de chaque plat (validation Lilia Food)',
        'Validation qualité finale par l\'équipe Ops',
        'Formation rapide du restaurateur sur l\'admin app',
        'Activation : isActive = true → restaurant visible dans l\'app client',
      ]),

      h2('Signature contrat'),
      ...bullets([
        'Commission Lilia : 15-25% selon segment (à négocier)',
        'Versement hebdomadaire (jour fixe)',
        'Engagement minimum : 3 mois',
        'Préavis de rupture : 30 jours',
      ]),

      h2('Création menu'),
      ...bullets([
        'Catégorisation claire (Entrées, Plats, Desserts, Boissons)',
        'Variants pour les options (taille, accompagnement)',
        'Stock quotidien : null = illimité, sinon décrémenté à chaque commande',
        'Reset auto à 5h UTC+1 chaque jour',
      ]),

      h2('Photos & qualité'),
      callout(
        'Les photos sont un facteur N°1 de conversion. Lilia Food peut fournir un photographe partenaire au tarif négocié.',
        '📸',
        'orange_background',
      ),
      ...bullets([
        'Format carré 1:1, 1080×1080 minimum',
        'Éclairage naturel, fond neutre',
        'Plat seul, sans logo ni filigrane',
        'Validation Ops avant publication',
      ]),

      h2('Commissions'),
      ...bullets([
        'Standard : 18% sur le sous-total HT',
        'Premium (placement bannière, push) : 15%',
        'Gargote / petit volume : 25%',
        'Période de découverte (3 premiers mois) : -5pp',
      ]),

      h2('Dashboard restaurant (en bref)'),
      ...bullets([
        'Endpoint GET /orders/restaurant — paginé',
        'PATCH /orders/:id/status (PAYER → EN_PREPARATION → PRET)',
        'Assignation livreur via PATCH /deliveries/by-order/:orderId/assign',
      ]),

      h2('SLA'),
      ...bullets([
        'Confirmation commande : < 5 min après réception (FCM)',
        'Préparation : selon estimatedDeliveryTimeMin–Max du restaurant',
        'Annulations restaurant : < 5% des commandes/semaine',
      ]),

      h2('Gestion incidents'),
      ...bullets([
        'Commande non préparable (stock épuisé non mis à jour) → annuler + notifier client',
        'Livreur tarde > 30 min → contact direct via app livreur',
        'Plainte client → support Lilia traite, restaurant fournit infos si demandé',
      ]),
    ],
  };
}

function restaurantDashboardPage(): PageDef {
  return {
    title: 'Dashboard restaurant',
    icon: '🖥️',
    children: [
      h2('Endpoints'),
      ...bullets([
        'GET /orders/restaurant?status&paginate',
        'PATCH /orders/:id/status',
        'GET /products /restaurant (CRUD produits)',
        'PATCH /restaurants/:id (horaires, override isOpen)',
        'GET /deliveries/deliverers (livreurs dispo)',
        'PATCH /deliveries/by-order/:orderId/assign',
      ]),
      h2('Workflow type commande'),
      ...bullets([
        'Recevoir notif FCM "Nouvelle commande"',
        'Confirmer dans l\'app → status PAYER → EN_PREPARATION',
        'Préparer puis status → PRET',
        'Assigner livreur → notif livreur',
        'Livreur accepte → status EN_ROUTE (auto)',
        'Livreur marque LIVRER → loyalty points crédités au client',
      ]),
    ],
  };
}

function slaPage(): PageDef {
  return {
    title: 'SLA & qualité',
    icon: '📐',
    children: [
      h2('SLAs côté restaurant'),
      ...bullets([
        'Acceptation commande : < 5 minutes après notif FCM',
        'Temps de préparation tenu : > 90% des commandes',
        'Taux d\'annulation : < 5% / semaine',
        'Disponibilité stock : > 95% (éviter "rupture" qui force annulation)',
      ]),
      h2('SLAs côté Lilia Food'),
      ...bullets([
        'Versement hebdomadaire : J+2 ouvré après période',
        'Réponse support : < 2h en heures ouvrées',
        'Résolution incident grave : < 24h',
      ]),
    ],
  };
}

function numberedSteps(items: string[]) {
  return items.map(numbered);
}
