import {
  bullets,
  callout,
  code,
  divider,
  h2,
  h3,
  numbered,
  p,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 4 — Application Livreur (lilia_food_delivery) + page "Conditions livreurs".
 */
export function buildRiderAppSection(): PageDef {
  return {
    title: '4. Application Livreur',
    icon: '🛵',
    children: [
      p(
        'App Flutter dédiée aux livreurs Lilia Food. Mission, navigation, tracking GPS, gains.',
      ),
      h2('Stack'),
      ...bullets([
        'Flutter 3.41+ (org com.dreesis)',
        'Riverpod',
        'Socket.io client + LocationService (geolocator)',
        'Firebase Auth (rôle LIVREUR)',
      ]),
      h2('Sous-pages'),
      ...bullets([
        'Onboarding livreur',
        'Validation des documents',
        'Disponibilité (DriverStatus)',
        'Réception missions',
        'Navigation + GPS',
        'Historique gains',
        'Portefeuille',
        'Conditions livreurs',
      ]),
    ],
    subPages: [
      onboardingRiderPage(),
      missionsPage(),
      gpsTrackingPage(),
      earningsPage(),
      conditionsRidersPage(),
    ],
  };
}

function onboardingRiderPage(): PageDef {
  return {
    title: 'Onboarding livreur',
    icon: '📋',
    children: [
      h2('Étapes'),
      ...numberedSteps([
        'Inscription Firebase (téléphone ou email)',
        'POST /users/sync',
        'Soumission documents : CNI, permis moto, photo véhicule',
        'Validation manuelle ADMIN',
        'Promotion role=LIVREUR',
        'Activation DriverStatus=AVAILABLE',
      ]),
      h2('Documents requis'),
      ...bullets([
        'Carte d\'identité (recto/verso)',
        'Permis de conduire moto',
        'Photo du véhicule + immatriculation',
        'Justificatif de domicile (optionnel)',
      ]),
    ],
  };
}

function missionsPage(): PageDef {
  return {
    title: 'Réception missions',
    icon: '🚚',
    children: [
      h2('Flux'),
      ...numberedSteps([
        'Restaurant assigne (PATCH /deliveries/by-order/:orderId/assign)',
        'Notification FCM "Nouvelle mission"',
        'Livreur ouvre l\'app → GET /deliveries/my-missions',
        'PATCH /deliveries/:id/accept → Order EN_ROUTE',
        'Navigation vers le resto, récupération, livraison',
        'PATCH /deliveries/:id/status (LIVRER ou ECHEC)',
      ]),
      callout(
        'État DriverStatus passe à ON_DELIVERY au accept, retourne à AVAILABLE au LIVRER/ECHEC.',
        'ℹ️',
      ),
    ],
  };
}

function gpsTrackingPage(): PageDef {
  return {
    title: 'Navigation + GPS',
    icon: '🗺️',
    children: [
      h2('Architecture'),
      ...bullets([
        'TrackingSocketService : Socket.io /tracking',
        'LocationService : geolocator stream',
        'Push WebSocket toutes les 5s',
        'Fallback HTTP POST /deliveries/:id/location toutes les 15s',
      ]),
      h2('Permissions'),
      ...bullets([
        'Android : ACCESS_FINE_LOCATION + ACCESS_BACKGROUND_LOCATION',
        'iOS : NSLocationWhenInUseUsageDescription + NSLocationAlwaysAndWhenInUseUsageDescription',
      ]),
    ],
  };
}

function earningsPage(): PageDef {
  return {
    title: 'Historique gains',
    icon: '💰',
    children: [
      h2('Endpoints'),
      ...bullets([
        'GET /deliveries/mine?status=LIVRER&paginate',
        'Calcul gains côté backend (à venir — voir Roadmap)',
      ]),
      h2('Modèle économique livreur'),
      ...bullets([
        'Part variable du deliveryFee de la commande',
        'Bonus en fonction du nombre de courses / semaine',
        'Bonus zone tendue (futur)',
      ]),
    ],
  };
}

/**
 * Page commerciale "Conditions livreurs" demandée explicitement dans le brief.
 */
function conditionsRidersPage(): PageDef {
  return {
    title: 'Conditions livreurs',
    icon: '📜',
    children: [
      callout(
        'Document de référence. Tout livreur doit en avoir pris connaissance avant d\'accepter sa 1ère mission.',
        '📜',
        'blue_background',
      ),

      h2('1. Conditions d\'accès à la plateforme'),
      ...bullets([
        'Avoir 18 ans révolus',
        'Posséder un permis de conduire moto valide',
        'Disposer d\'un véhicule en bon état (moto ou vélo électrique)',
        'Avoir un smartphone Android 8+ ou iOS 14+',
        'Forfait data minimum 2 Go/mois',
        'Téléphone résident à Brazzaville',
      ]),

      h2('2. Règles de la plateforme'),
      ...bullets([
        'Respect strict du Code de la route congolais',
        'Casque obligatoire',
        'Téléphone monté sur support (jamais en main pendant la conduite)',
        'Aucune sous-traitance : seul le livreur enregistré accepte la course',
        'Tenue correcte exigée (gilet Lilia Food fourni)',
        'Politesse et respect envers clients ET restaurateurs',
      ]),

      h2('3. Comportement attendu'),
      ...bullets([
        'Confirmer la mission dans les 60 secondes après assignation',
        'Annonce de l\'arrivée au restaurant et au client',
        'Vérifier que la commande est complète avant de partir du resto',
        'Aucune consommation ou modification de la commande',
        'Photo de remise si demandée par le client',
      ]),

      h2('4. Zones de livraison'),
      ...bullets([
        'Zone primaire Brazzaville : Centre-ville, Bacongo, Poto-Poto, Moungali',
        'Zone secondaire : Talangaï, Mfilou, Madibou',
        'Zones exclues sauf accord ponctuel : Kintélé, Linzolo',
      ]),

      h2('5. Système de notation'),
      ...bullets([
        'Note moyenne calculée sur les 50 dernières courses',
        'Note < 3.5 → coaching obligatoire',
        'Note < 3.0 sur 30 courses consécutives → suspension',
        'Bonus mensuel pour note ≥ 4.8',
      ]),

      h2('6. Pénalités'),
      ...bullets([
        'Annulation injustifiée : 1ère = avertissement, 2ème = -10% bonus, 3ème = suspension 48h',
        'Retard > 15min sans raison déclarée : avertissement',
        'Mission refusée 3 fois consécutivement : pause obligatoire 1h',
        'Plainte client grave validée : suspension immédiate enquête',
      ]),

      h2('7. Bonus'),
      ...bullets([
        '+500 XAF par course livrée en heure de pointe (12h–14h, 19h–21h)',
        '+2000 XAF / semaine si 50+ courses',
        '+5000 XAF / semaine si note moyenne ≥ 4.9',
        'Bonus zone tendue (à activer ponctuellement)',
      ]),

      h2('8. Sécurité'),
      ...bullets([
        'Bouton "Incident" dans l\'app → notif immédiate équipe Ops',
        'Position GPS envoyée toutes les 5 secondes (sauvegarde Redis + DB)',
        'Numéro d\'urgence Lilia Food affiché en permanence',
        'Couverture assurance responsabilité civile (incluse)',
      ]),

      h2('9. Maintenance moto'),
      ...bullets([
        'Le livreur reste responsable de l\'entretien de son véhicule',
        'Partenaires garages référencés : tarifs négociés via Lilia',
        'Contrôle technique annuel obligatoire',
      ]),

      h2('10. Procédures incidents'),
      ...bullets([
        'Accident → arrêter, sécuriser, ouvrir un Incident via app',
        'Vol/agression → 117 (police) + bouton "Incident" en parallèle',
        'Commande perdue/abîmée → photo + Incident → résolution Ops',
        'Conflit client → ne pas s\'engager, transmettre au support',
      ]),

      divider(),
      p(
        'Document mis à jour automatiquement par le script de bootstrap des docs Notion. Pour modifier ces conditions, éditer rider-app.builder.ts et re-run POST /notion/docs/bootstrap.',
      ),
    ],
  };
}

function numberedSteps(items: string[]) {
  return items.map(numbered);
}
