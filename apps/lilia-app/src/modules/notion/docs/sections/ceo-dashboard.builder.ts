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
 * Section 7 — CEO Dashboard.
 * Page d'overview avec les KPIs principaux. Les valeurs réelles seront
 * alimentées par un cron à venir (voir Roadmap).
 */
export function buildCeoDashboardSection(): PageDef {
  return {
    title: '7. CEO Dashboard',
    icon: '📊',
    children: [
      callout(
        'Vue exécutive du business. Les KPIs ci-dessous seront alimentés automatiquement par un cron quotidien (à implémenter — voir section 8 Roadmap).',
        '👔',
        'blue_background',
      ),

      h2('KPIs principaux'),
      table(
        ['Indicateur', 'Source', 'Fréquence', 'Cible'],
        [
          ['GMV quotidien (XAF)', 'sum(Order.total) WHERE date=today AND status≠ANNULER', 'Daily', 'À fixer'],
          ['Nombre commandes / jour', 'count(Order) WHERE date=today AND status≠ANNULER', 'Daily', '+10% MoM'],
          ['Panier moyen', 'avg(Order.total)', 'Weekly', '> 4000 XAF'],
          ['Taux annulation', 'count(ANNULER) / count(*)', 'Weekly', '< 5%'],
          ['Livreurs actifs (semaine)', 'count distinct delivererId', 'Weekly', 'En croissance'],
          ['Restaurants actifs', 'Restaurant WHERE isActive AND last_order_at < 7d', 'Weekly', '> 80% du total'],
          ['Nouveaux clients', 'count(User WHERE createdAt=this week)', 'Weekly', '+'],
          ['Note moyenne plateforme', 'avg(Review.rating)', 'Weekly', '≥ 4.5'],
          ['Taux remboursement', 'sum(refunds) / GMV', 'Monthly', '< 2%'],
          ['Commission moyenne %', 'Lilia revenue / GMV', 'Monthly', 'Stable'],
        ],
      ),

      h2('Sources de données'),
      ...bullets([
        'GET /dashboard/* (7 endpoints) — Prisma agrégations',
        'Notion DB "Orders" (sync event-driven)',
        'Notion DB "Incidents" (sync event-driven)',
      ]),

      h2('Sous-pages'),
      ...bullets([
        'Revenus & GMV',
        'Croissance utilisateurs',
        'Performance livreurs',
        'Marketing & acquisition',
        'Finances',
      ]),
    ],
    subPages: [
      revenuePage(),
      growthPage(),
      ridersPerfPage(),
      marketingPage(),
      financesPage(),
    ],
  };
}

function revenuePage(): PageDef {
  return {
    title: 'Revenus & GMV',
    icon: '💵',
    children: [
      h2('Définitions'),
      ...bullets([
        'GMV (Gross Merchandise Value) : somme des Order.total non annulés',
        'Net revenue Lilia : GMV × commission moyenne (~18%)',
        'Marge Lilia : net revenue − coûts variables (livreur, support, paiement)',
      ]),
      h2('Décomposition'),
      ...bullets([
        'subTotal — part restaurant',
        'serviceFee 8% — frais plateforme',
        'deliveryFee — part livreur (rétrocédée)',
        'discountAmount — promo + loyalty points',
      ]),
    ],
  };
}

function growthPage(): PageDef {
  return {
    title: 'Croissance utilisateurs',
    icon: '📈',
    children: [
      h2('Métriques'),
      ...bullets([
        'Nouveaux clients / semaine',
        'DAU / WAU / MAU',
        'Taux de rétention J+7, J+30',
        'Cohort analysis (à industrialiser)',
      ]),
      h2('Sources d\'acquisition'),
      ...bullets([
        'Organique',
        'Parrainage (referralCode)',
        'Campagnes marketing (à tracker via UTM dans le futur)',
      ]),
    ],
  };
}

function ridersPerfPage(): PageDef {
  return {
    title: 'Performance livreurs',
    icon: '🛵',
    children: [
      h2('Métriques'),
      ...bullets([
        'Nombre courses / livreur / semaine',
        'Note moyenne par livreur',
        'Temps moyen de livraison vs ETA',
        'Taux d\'acceptation missions',
      ]),
      h2('Top performers'),
      p('À automatiser : weekly report Notion avec top 10 livreurs (Roadmap).'),
    ],
  };
}

function marketingPage(): PageDef {
  return {
    title: 'Marketing & acquisition',
    icon: '📣',
    children: [
      h2('Canaux actuels'),
      ...bullets([
        'Word-of-mouth (parrainage natif)',
        'Social media (Facebook, Instagram Brazzaville)',
        'Partenariats restaurants',
      ]),
      h2('À développer'),
      ...bullets([
        'Tracking UTM sur les URLs deep link',
        'Mesure CAC (Customer Acquisition Cost) par canal',
        'Programme ambassadeurs',
      ]),
    ],
  };
}

function financesPage(): PageDef {
  return {
    title: 'Finances',
    icon: '🧮',
    children: [
      h2('Cash flow'),
      ...bullets([
        'Entrées : commissions + frais plateforme',
        'Sorties : versements restaurants hebdo, livreurs hebdo, salaires Ops, infrastructure',
        'Solde MTN MoMo Lilia (vue temps réel via dashboard MTN)',
      ]),
      h2('Reporting comptable'),
      ...bullets([
        'Export mensuel commandes payées',
        'Réconciliation MTN MoMo / DB',
        'TVA & fiscalité (à formaliser avec un comptable local)',
      ]),
    ],
  };
}
