import {
  bullets,
  callout,
  h2,
  h3,
  p,
  table,
} from '../docs-block.helpers';
import { PageDef } from '../page-def.types';

/**
 * Section 8 — Roadmap produit.
 */
export function buildRoadmapSection(): PageDef {
  return {
    title: '8. Roadmap produit',
    icon: '🗺️',
    children: [
      callout(
        'Source de vérité de la roadmap produit. Synchronisée avec les sprints Notion (database à créer en suite — bonus du brief).',
        '🧭',
        'green_background',
      ),
      h2('Vue d\'ensemble'),
      table(
        ['Initiative', 'Statut', 'Priorité', 'ETA'],
        [
          ['Sync Notion + bootstrap docs', 'En cours', 'P0', 'Mai 2026'],
          ['Sync entités étendues (riders, users, deliveries)', 'À faire', 'P1', 'Juin 2026'],
          ['Daily ops digest auto (cron)', 'À faire', 'P1', 'Juin 2026'],
          ['Wallet client (recharge MTN)', 'Idée', 'P2', 'Q3 2026'],
          ['Programme fidélité v2 (paliers)', 'Idée', 'P2', 'Q3 2026'],
          ['Réservation restaurant (sur place)', 'Idée', 'P3', 'Q4 2026'],
          ['Chat client ↔ livreur', 'Idée', 'P2', 'Q3 2026'],
          ['IA — recommandations plats', 'Idée', 'P3', '2027'],
          ['Expansion Pointe-Noire', 'Idée', 'P3', 'Q4 2026'],
          ['Multi-restaurants par commande', 'Idée', 'P3', '2027'],
        ],
      ),
      h2('Sous-pages'),
      ...bullets([
        'Backlog actuel',
        'Sprints',
        'Idées futures',
        'Bugs',
        'Fonctionnalités IA',
        'Fintech (Wallet, etc.)',
      ]),
    ],
    subPages: [
      backlogPage(),
      sprintsPage(),
      ideasPage(),
      bugsPage(),
      aiFeaturesPage(),
      fintechPage(),
    ],
  };
}

function backlogPage(): PageDef {
  return {
    title: 'Backlog actuel',
    icon: '📥',
    children: [
      h2('P0 — Critique'),
      ...bullets([
        '[Notion] Sync orders/restaurants/incidents (DONE)',
        '[Notion] Bootstrap structure docs',
      ]),
      h2('P1 — Important'),
      ...bullets([
        '[Notion] Extension sync : riders, users, deliveries',
        '[Notion] Reverse sync : Notion → Backend pour incidents resolved',
        '[Ops] Daily ops digest auto (cron 22h UTC+1)',
        '[Ops] Weekly CEO report (cron lundi 8h)',
      ]),
      h2('P2 — Important non urgent'),
      ...bullets([
        '[Wallet] Recharge MTN, paiement par solde',
        '[Fidélité] Système de paliers (Bronze/Argent/Or)',
        '[Chat] In-app client ↔ livreur (Socket.io)',
        '[Restaurant] Bannières premium auto-gérées',
      ]),
    ],
  };
}

function sprintsPage(): PageDef {
  return {
    title: 'Sprints',
    icon: '🏃',
    children: [
      callout(
        'À convertir en database Notion pour gestion sprint par sprint (bonus — voir POST /notion/bootstrap dont la sync future inclura les sprints).',
        '📌',
      ),
      h2('Sprint actuel (Mai 2026)'),
      ...bullets([
        'Notion integration complète (Part 1 + Part 2 du brief)',
        'Corrections bugs livreur (cf CLAUDE.md mai 2026)',
        'Migration CASH_ON_DELIVERY → MTN_MOMO uniquement',
      ]),
    ],
  };
}

function ideasPage(): PageDef {
  return {
    title: 'Idées futures',
    icon: '💡',
    children: [
      h2('Court terme (Q3 2026)'),
      ...bullets([
        'Réservation table restaurant (sur place)',
        'Plats du jour automatiques (push à 11h30)',
        'Commande de groupe (1 panier, plusieurs payeurs)',
      ]),
      h2('Moyen terme (Q4 2026)'),
      ...bullets([
        'Expansion Pointe-Noire (POC 5 restaurants)',
        'Espace pro / bureaux (livraisons batch)',
        'Carte cadeau Lilia',
      ]),
      h2('Long terme (2027+)'),
      ...bullets([
        'Lilia Wallet : devenir le portefeuille du quotidien',
        'Lilia Fresh : courses du marché Brazza',
        'Lilia Ride : motos-taxis B2C',
      ]),
    ],
  };
}

function bugsPage(): PageDef {
  return {
    title: 'Bugs',
    icon: '🐛',
    children: [
      callout(
        'À convertir en database Notion pour tracking dédié.',
        '🐛',
      ),
      h2('Bugs ouverts connus'),
      ...bullets([
        'Admin Flutter tente toujours de se connecter à /notifications/sse (endpoint supprimé) — code mort à nettoyer',
        'Worker app squelette non utilisé — décider activation ou suppression',
        'OrderLifecycleStatus enum Prisma non lu — décider activation ou suppression',
      ]),
    ],
  };
}

function aiFeaturesPage(): PageDef {
  return {
    title: 'Fonctionnalités IA',
    icon: '🤖',
    children: [
      h2('Idées priorisables'),
      ...bullets([
        'Recommandations plats personnalisées (historique commandes)',
        'Prédiction temps de préparation par resto / heure',
        'Détection anomalies : commandes suspectes, fraude paiement',
        'AI summaries d\'incidents pour Notion (intégration Anthropic API)',
        'Réponses templates support assistées',
      ]),
      h2('Stack envisagée'),
      ...bullets([
        'Anthropic API (Claude) pour text generation',
        'Embeddings sur historique commandes (pgvector futur)',
      ]),
    ],
  };
}

function fintechPage(): PageDef {
  return {
    title: 'Fintech (Wallet, etc.)',
    icon: '🏦',
    children: [
      h2('Wallet client'),
      ...bullets([
        'Solde XAF rechargeable via MTN MoMo / Airtel',
        'Paiement instantané sans saisir téléphone à chaque commande',
        'Recharge minimum 1000 XAF, max 200 000 XAF',
        'Conformité KYC à anticiper (régulateur Congo)',
      ]),
      h2('Versement restaurants'),
      ...bullets([
        'Automatisation des versements hebdo (au lieu de manuel actuel)',
        'API MTN MoMo Disbursement',
        'Reconciliation auto avec sales du restaurant',
      ]),
      h2('Versement livreurs'),
      ...bullets([
        'Idem versement hebdo automatisé',
        'Wallet livreur intermédiaire (paye le carburant directement)',
      ]),
    ],
  };
}
