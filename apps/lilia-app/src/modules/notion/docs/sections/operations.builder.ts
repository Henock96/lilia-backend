import {
  bullets,
  callout,
  h2,
  h3,
  numbered,
  p,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 6 — Opérations.
 */
export function buildOperationsSection(): PageDef {
  return {
    title: '6. Opérations',
    icon: '⚡',
    children: [
      callout(
        'Playbooks pour l\'équipe Ops Lilia Food. À mettre à jour à chaque nouvelle procédure.',
        '🎛️',
        'orange_background',
      ),
      p('Procédures opérationnelles couvrant dispatch, incidents, support, urgences.'),
      h2('Sous-pages'),
      ...bullets([
        'Dispatching commandes',
        'Gestion incidents',
        'Remboursements',
        'Service client / Support',
        'Gestion retards',
        'Gestion annulations',
        'Gestion livreurs',
        'Procédures d\'urgence',
      ]),
    ],
    subPages: [
      dispatchingPage(),
      incidentsOpsPage(),
      refundsPage(),
      supportPage(),
      delaysPage(),
      cancellationsPage(),
      ridersManagementPage(),
      emergencyPage(),
    ],
  };
}

function dispatchingPage(): PageDef {
  return {
    title: 'Dispatching commandes',
    icon: '📦',
    children: [
      h2('Mode actuel'),
      p('Assignation déléguée au restaurateur via PATCH /deliveries/by-order/:orderId/assign. L\'admin peut prendre le relais en cas de non-action > 5 min après PRET.'),
      h2('Critères d\'assignation idéale'),
      ...bullets([
        'Livreur disponible (DriverStatus=AVAILABLE)',
        'Proximité géographique du restaurant',
        'Note moyenne ≥ 4.0',
        'Pas plus de 1 mission en cours (futur : multi-orders)',
      ]),
      h2('Escalade admin'),
      ...bullets([
        'Commande PRET > 5 min sans assignation → notif équipe Ops',
        'Ops choisit un livreur via le dashboard',
        '> 15 min : appel direct au livreur',
      ]),
    ],
  };
}

function incidentsOpsPage(): PageDef {
  return {
    title: 'Gestion incidents',
    icon: '🚨',
    children: [
      h2('Création d\'un incident'),
      ...bullets([
        'Automatique : order.cancelled → IncidentsListener crée un incident ORDER_CANCELLED',
        'Manuelle (ADMIN) : POST /incidents avec type, severity, description',
        'Auto-sync vers Notion (database "Incidents")',
      ]),
      h2('Types'),
      ...bullets([
        'ORDER_CANCELLED, ORDER_DELAYED, PAYMENT_FAILED',
        'DRIVER_NO_SHOW, DRIVER_ACCIDENT',
        'CUSTOMER_COMPLAINT, RESTAURANT_CLOSED, STOCK_ISSUE',
        'WRONG_DELIVERY, REFUND_REQUEST, OTHER',
      ]),
      h2('Process de résolution'),
      ...numbered_steps([
        'Triage initial — assigner severity (LOW / MEDIUM / HIGH / CRITICAL)',
        'PATCH /incidents/:id status=IN_PROGRESS',
        'Diagnostic + actions correctives',
        'PATCH /incidents/:id status=RESOLVED avec resolution',
        'Reporting hebdo (à automatiser, voir section 7)',
      ]),
    ],
  };
}

function refundsPage(): PageDef {
  return {
    title: 'Remboursements',
    icon: '💰',
    children: [
      h2('Cas légitimes'),
      ...bullets([
        'Commande non livrée (DRIVER_NO_SHOW)',
        'Produit absent / différent / périmé',
        'Annulation côté restaurant après paiement',
        'Force majeure (panne app, paiement double)',
      ]),
      h2('Process'),
      ...numbered_steps([
        'Créer un Incident type REFUND_REQUEST',
        'Vérifier le Payment.status (doit être SUCCESS)',
        'Initier remboursement MTN MoMo (manuel pour l\'instant)',
        'Documenter dans Incident.resolution',
        'Status incident → RESOLVED',
      ]),
      callout(
        'Pas encore d\'endpoint automatisé /refunds — process manuel via dashboard MTN MoMo.',
        '⚠️',
        'yellow_background',
      ),
    ],
  };
}

function supportPage(): PageDef {
  return {
    title: 'Service client / Support',
    icon: '🆘',
    children: [
      h2('Canaux'),
      ...bullets([
        'In-app : "Aide" → ouverture Incident',
        'WhatsApp : numéro Lilia Ops',
        'Téléphone direct (heures ouvrées)',
      ]),
      h2('SLA réponse'),
      ...bullets([
        'Premier contact : < 30 min en heures ouvrées',
        'Résolution standard : < 24h',
        'Incident CRITICAL : < 1h',
      ]),
      h2('Heures ouvrées'),
      p('Lun–Sam 8h–22h, Dim 10h–22h (UTC+1). Hors heures, équipe d\'astreinte pour CRITICAL only.'),
    ],
  };
}

function delaysPage(): PageDef {
  return {
    title: 'Gestion retards',
    icon: '⏰',
    children: [
      h2('Détection'),
      ...bullets([
        'Auto via comparaison ETA Haversine vs temps écoulé',
        'Alerte Ops si delivery > estimatedDeliveryTimeMax + 15min',
      ]),
      h2('Actions'),
      ...numbered_steps([
        'Contact livreur via app',
        'Vérifier position GPS Redis',
        'Si bloqué/perdu : guider via Ops',
        'Si > 1h de retard : créer Incident ORDER_DELAYED + geste commercial',
      ]),
    ],
  };
}

function cancellationsPage(): PageDef {
  return {
    title: 'Gestion annulations',
    icon: '❌',
    children: [
      h2('Annulation client'),
      ...bullets([
        'Possible uniquement en EN_ATTENTE (avant paiement)',
        'PATCH /orders/:id/cancel — emit order.cancelled',
        'Auto-création Incident ORDER_CANCELLED (LOW severity si pas de paiement)',
      ]),
      h2('Annulation restaurant'),
      ...bullets([
        'Cas légitimes : rupture stock confirmée, fermeture exceptionnelle',
        'Doit annuler dans les 5 min après PAYER',
        'Si paiement déjà collecté → remboursement obligatoire',
        'Incident severity HIGH si récurrent',
      ]),
      h2('Annulation Ops'),
      ...bullets([
        'Cas extrêmes : fraude, incident sécurité, force majeure',
        'Toujours documenter dans Incident',
      ]),
    ],
  };
}

function ridersManagementPage(): PageDef {
  return {
    title: 'Gestion livreurs',
    icon: '🛵',
    children: [
      h2('Recrutement'),
      ...bullets([
        'Sourcing : recommandations + partenariats moto-taxi',
        'Documents (cf section 4)',
        'Entretien Ops',
        'Période d\'essai : 50 premières courses',
      ]),
      h2('Suivi performance'),
      ...bullets([
        'Note moyenne 50 dernières courses',
        'Taux d\'acceptation missions',
        'Temps moyen de livraison vs ETA',
      ]),
      h2('Sanctions'),
      ...bullets([
        'Voir page "Conditions livreurs" (section 4)',
      ]),
    ],
  };
}

function emergencyPage(): PageDef {
  return {
    title: 'Procédures d\'urgence',
    icon: '🆘',
    children: [
      callout(
        'Numéros à connaître par tous les membres de l\'équipe Ops.',
        '☎️',
        'red_background',
      ),
      h2('Numéros utiles Brazzaville'),
      ...bullets([
        'Police : 117',
        'Pompiers : 118',
        'SAMU / Urgences médicales : 3434',
        'Lilia Food astreinte 24/7 : (à compléter)',
      ]),
      h2('Scénarios'),
      ...bullets([
        'Accident livreur grave → SAMU + assurance + Incident CRITICAL',
        'Agression livreur → 117 puis Lilia + Incident CRITICAL',
        'Coupure générale d\'internet → mode dégradé : commandes téléphone',
        'Bug critique app → rollback Render + status page (à créer)',
      ]),
    ],
  };
}

function numbered_steps(items: string[]) {
  return items.map(numbered);
}
