# Sauvegarde, restauration et retour arrière

**Établi le 4 septembre 2026, par exécution réelle** — pas par lecture de
documentation fournisseur. La checklist de production portait
`[ ] Backup — NON VÉRIFIÉ` et `[ ] Rollback — NON VÉRIFIÉ` ; ces deux lignes
sont désormais adossées à des mesures.

> **Le principe.** « Le fournisseur fait des sauvegardes » n'est pas une
> stratégie de restauration. Ce qui compte est : *que peut-on remettre en
> ligne, en combien de temps, et l'a-t-on déjà fait une fois ?*

---

## 1. Ce qui a été réellement vérifié

| Mesure | Résultat | Date |
|---|---|---|
| Version du serveur de production | PostgreSQL **17.11** (Neon, région `us-east-1`) | 04/09/2026 |
| `pg_dump -Fc` complet depuis un poste de développement | **43 s**, archive de **202 Ko** | 04/09/2026 |
| `pg_restore` sur une base vierge | **0,8 s**, aucune erreur | 04/09/2026 |
| Intégrité après restauration | 65 `User` · 117 `Order` · 50 `payments` · 112 `PaymentEvent` · 6 `Restaurant` · 47 `Adresses` — **identiques à la source** | 04/09/2026 |

**Objectif de reprise mesuré (RTO), voie logique : moins de 2 minutes**, dump
et restauration compris, à la taille actuelle des données. Ce chiffre croîtra
avec le volume ; il est à remesurer tous les trimestres.

⚠️ **Objectif de point de reprise (RPO) : celui du dernier dump.** Un dump
manuel ne protège que jusqu'à sa propre date. C'est la voie de secours, pas la
protection principale — voir §2.

---

## 2. Les trois voies de restauration, par ordre de préférence

### Voie A — Restauration dans le temps (Neon), **à privilégier**

Neon conserve un historique continu permettant de remonter une branche à un
instant donné. C'est la seule voie dont le RPO se compte en secondes.

```
Console Neon → projet → Branches → « Restore »
  ├─ choisir l'instant cible (juste AVANT l'incident)
  └─ restaurer dans une NOUVELLE branche, jamais sur `main`
```

**Toujours restaurer dans une branche.** Écraser la branche de production
détruit l'état courant — y compris les commandes passées *pendant* l'incident,
qui sont souvent celles qu'on cherche à sauver. On compare les deux branches,
puis on bascule la chaîne de connexion.

🔴 **À CONFIRMER en console** (nécessite un accès que ce dépôt n'a pas) :
la **fenêtre de rétention** du plan Neon souscrit. Elle va de 24 h à 30 jours
selon l'offre. Tant que ce chiffre n'est pas écrit ici, on ne sait pas jusqu'où
on peut remonter — et un incident découvert le lundi matin peut être hors de
portée.

### Voie B — Restauration logique depuis un `pg_dump`

Indépendante du fournisseur : c'est elle qui protège d'une perte du compte
Neon, d'une suppression de projet ou d'une erreur de facturation.

```bash
# ── Sauvegarde (lecture seule sur la source) ────────────────────────────────
pg_dump "$DATABASE_URL_PROD" -Fc --no-owner --no-privileges \
  -f "lilia-prod-$(date +%Y%m%d-%H%M).dump"

# ── Restauration sur une base NEUVE ─────────────────────────────────────────
createdb lilia_restore
pg_restore -d lilia_restore --no-owner --no-privileges lilia-prod-….dump

# ── Vérification AVANT toute bascule ────────────────────────────────────────
psql -d lilia_restore -tAc "
  select 'User', count(*) from \"User\"
  union all select 'Order', count(*) from \"Order\"
  union all select 'payments', count(*) from payments
  order by 1"
```

`--no-owner --no-privileges` : les rôles de Neon n'existent pas ailleurs, et
leur absence ferait échouer la restauration sur une base locale ou chez un
autre hébergeur — c'est-à-dire exactement le jour où on en a besoin.

⚠️ **`pg_dump` 18 lit un serveur 17** (c'est le sens supporté : client ≥
serveur). L'inverse ne fonctionne pas — ne jamais restaurer une archive
produite par un client plus récent que le serveur cible.

### Voie C — Reconstruction depuis les migrations

`npx prisma migrate deploy` recrée le **schéma** (61 migrations au 04/09/2026),
jamais les données. Utile pour reconstruire un environnement, inutile pour un
incident de production. Mentionnée ici pour qu'elle ne soit pas confondue avec
une restauration.

---

## 3. Ce qui manque encore — et qui est un vrai risque

| Manque | Conséquence | Correctif |
|---|---|---|
| **Aucun dump automatisé hors Neon** | Une perte du compte Neon perd tout. La voie B n'existe aujourd'hui que si quelqu'un pense à lancer la commande. | Tâche planifiée quotidienne poussant l'archive vers un stockage tiers, avec rétention 30 jours. |
| **Rétention Neon inconnue** | On ignore jusqu'où la voie A permet de remonter. | Relever la valeur en console et l'écrire au §2. |
| **Aucune restauration jamais faite sur l'environnement de production** | Le protocole est validé sur une base locale, pas sur la cible réelle. | Un exercice sur une branche Neon, chronométré, avant le lancement. |

---

## 4. Retour arrière applicatif

### Backend — Render

Render conserve les déploiements précédents. Un retour arrière remet le
**conteneur** dans son état antérieur.

```
Dashboard Render → service → Events → déploiement précédent → « Rollback »
```

🔴 **Le retour arrière du code ne défait pas les migrations.**
`npm run render-build` exécute `prisma migrate deploy` : si le déploiement
fautif portait une migration, revenir au code précédent laisse la base dans le
nouveau schéma. Le code ancien s'exécute alors contre un schéma qu'il ne
connaît pas.

**Règle de conception, déjà appliquée** : toute migration doit être **additive**
et compatible avec la version précédente du code. C'est exactement le protocole
suivi par `20260901120000_delivery_destination` (« entièrement additive : une
instance de l'ancien code tourne dessus ») et par
`20260830120000_vendor_onboarding` (colonnes nullables ou avec défaut d'abord).

Une migration destructrice (`DROP COLUMN`, `ALTER TYPE` restrictif) rend le
retour arrière impossible sans restauration de base. Elle se découpe en deux
déploiements séparés par au moins un cycle : d'abord cesser de lire la colonne,
la supprimer ensuite.

### Web — Vercel

```
Dashboard Vercel → projet → Deployments → déploiement sain → « Promote to Production »
```

Instantané et sans effet de bord : les applications web ne portent aucun état.
Attention aux variables d'environnement — elles ne sont **pas** versionnées avec
le déploiement ; une variable modifiée entre-temps reste modifiée.

### Applications Flutter

**Il n'y a pas de retour arrière.** Une version publiée sur les stores reste
installée sur les téléphones qui l'ont prise. Deux conséquences permanentes :

1. le backend doit rester compatible avec les versions déployées — c'est la
   raison pour laquelle `CreateOrderDto.deliveryLatitude/Longitude` sont
   **conservés et ignorés**, et pour laquelle `toMsisdn` réinsère le zéro
   initial des numéros à onze chiffres envoyés par les anciennes versions ;
2. un défaut client se corrige par une **nouvelle** version, avec le délai de
   revue des stores. Prévoir un interrupteur côté serveur pour tout ce qui
   pourrait devoir être arrêté en urgence.

---

## 5. Marche à suivre en incident

```
1. CONSTATER      figer l'ampleur : depuis quand, quelles tables, combien de lignes
                  → ne rien réparer avant d'avoir mesuré
2. ISOLER         PATCH /admin/platform-settings { maintenanceMode: true }
                  → arrête la prise de commandes sans couper le service
3. SAUVEGARDER    pg_dump de l'état ACTUEL, même corrompu
                  → il contient les commandes passées pendant l'incident
4. RESTAURER      voie A dans une branche Neon (ou voie B sur une base neuve)
5. COMPARER       compter les lignes des deux côtés, identifier ce qui manque
                  de part et d'autre ; réintégrer à la main ce qui doit l'être
6. BASCULER       changer DATABASE_URL sur Render, redémarrer
7. VÉRIFIER       /health/ready, une commande de bout en bout, un paiement
8. ROUVRIR        maintenanceMode: false
9. ÉCRIRE         ce qui s'est passé, ce qui a manqué, ce qui a été mesuré
```

L'étape 3 est celle qu'on saute sous pression, et c'est celle qui rend les
autres réversibles.

---

## 6. Garde-fous déjà en place

- **`scripts/db/target-database.js`** — toute base non locale est traitée comme
  la production. `npm run db:seed`, `npm run db:reset:dev` et
  `delete-vendor.js --commit` refusent de s'exécuter contre elle, sauf
  `LILIA_ALLOW_PRODUCTION_WRITES=oui-je-sais-ce-que-je-fais`.
- **`.env.development`** (versionné, sans secret) pointe la base et Redis sur
  le poste local. La cascade `ConfigModule` est
  `.env.local` → `.env.<NODE_ENV>` → `.env`, première occurrence gagnante.
- **`npm run db:target`** affiche la base réellement visée. **Le réflexe avant
  toute commande destructrice.**
- **`scripts/db/dry-run-fk-migration.js`** — protocole de répétition à blanc :
  jouer la migration dans une transaction annulée. À rejouer pour toute
  migration structurelle future.
