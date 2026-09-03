# Centroïdes de quartier — état et qualification

**Dernière vérification : 2 septembre 2026.**

Un centroïde de quartier est le **repli de niveau 2** de
`DeliveryDestinationService` : quand une adresse client n'a pas de position
posée à la main, la commande prend le centroïde de son quartier et sort en
`APPROXIMATE`. Sans centroïde, elle sort en `UNKNOWN` et part sans destination.

C'est donc une donnée qui décide de ce que le livreur voit sur sa carte. Elle
se pose à la main, jamais par géocodage automatique.

---

## 1. Pourquoi on ne remplit pas les douze

Le géocodage du 01/09 a rendu **exactement le même point** — le centre
générique de Brazzaville — pour sept quartiers sur vingt-six. C'est ce que
Google répond quand il ne reconnaît pas un nom : il ne dit pas « je ne sais
pas », il dit « Brazzaville ». Les semer aurait produit sept quartiers
superposés, présentés comme distincts, et sept livreurs envoyés au même
carrefour.

**Règle** : n'accepter un résultat que si la source désigne **le lieu
lui-même** — un `neighbourhood`, un `administrative`, un `marketplace` qui
porte le nom du quartier. Un point d'intérêt *nommé d'après* le quartier
(une église Saint-Pierre, une station Texaco, une caserne de Bifouiti) situe
le point d'intérêt, pas le quartier.

`UNKNOWN` est une réponse valide. Une mauvaise coordonnée ne l'est pas.

## 2. État au 2 septembre 2026

`QUARTIERS_BRAZZAVILLE` (`modules/quartiers/quartiers.service.ts`) compte
**26 quartiers**. La migration `20260901120000_delivery_destination` en pose
**14**. Restent **12** sans centroïde.

> ⚠️ **Ces chiffres viennent du SQL, pas de la production.** Les `UPDATE` de
> la migration sont conditionnés sur `WHERE "nom" = '…'`. Un accent ou une
> casse différente en base ⇒ zéro ligne touchée, sans erreur. **Compter en
> production est un préalable**, cf. §5.

### Les 12 sans centroïde, et ce qu'une source indépendante en dit

Source consultée : OpenStreetMap (Nominatim), le 02/09/2026 — indépendante de
Google, sans clé, et qui expose le **type** de l'objet trouvé, ce qui permet
d'appliquer la règle du §1.

| Quartier | Résultat OSM | Type | Décision |
|---|---|---|---|
| **Marché Total** | Marché Total Bacongo | `marketplace` | 🟡 **candidat** |
| **Moukondo** | Moukondo, Moungali | `neighbourhood` | 🟢 **candidat** |
| **Nkombo** | Nkombo, Djiri | `neighbourhood` | 🟢 **candidat** |
| **Mfilou** | Mfilou (arrondissement 7) | `administrative` | 🟡 **candidat**, échelle arrondissement |
| **Djiri** | Djiri (arrondissement 9) | `administrative` | 🟡 **candidat**, échelle arrondissement |
| Bifouiti | communauté religieuse / caserne, 1,2 km d'écart | `place_of_worship`, `barracks` | ⛔ `UNKNOWN` |
| Saint-Pierre | Église Saint-Pierre-Claver | `place_of_worship` | ⛔ `UNKNOWN` |
| La Tsiémé | station-service, avenue de la Tsiémé | `fuel` | ⛔ `UNKNOWN` |
| Texaco | arrêt de bus / boulangerie, à Soukissa | `bus_stop`, `bakery` | ⛔ `UNKNOWN` |
| Massengo | lycée à Djiri **vs** marché à Mfilou — **8 km d'écart** | `school`, `tower` | ⛔ `UNKNOWN` |
| Mpissa | aucun résultat | — | ⛔ `UNKNOWN` |
| Kinsoundi | aucun résultat | — | ⛔ `UNKNOWN` |

Massengo mérite d'être regardé : deux résultats plausibles à huit kilomètres
l'un de l'autre. Choisir « le premier » aurait donné une chance sur deux
d'envoyer tous les livreurs du quartier à l'autre bout de la ville — et rien,
dans la donnée produite, ne l'aurait signalé.

### Ce que « candidat » veut dire

**Aucun de ces cinq points n'est appliqué automatiquement.** Ils sont proposés
à un administrateur qui connaît Brazzaville, seul juge de leur validité. Les
deux `administrative` (Mfilou, Djiri) sont des centroïdes d'**arrondissement**,
sensiblement plus grossiers qu'un quartier : ils restent honnêtes — la commande
sortira `APPROXIMATE`, et l'app livreur affiche « Position approximative —
appelez le client » — mais l'écart réel peut atteindre plusieurs kilomètres.

## 3. Poser un centroïde

```
PATCH /quartiers/:id/centroid     (ADMIN)
{ "latitude": -4.2316, "longitude": 15.2680 }
```

Le service valide contre `CONGO_BOUNDS` : `(0,0)`, inversion lat/lng et hors
Congo sont refusés avec un message qui dit quoi corriger.

Le script `scripts/db/propose-quartier-centroids.mjs` applique les cinq
candidats **après confirmation explicite** :

```bash
# 1. Lecture seule — affiche l'état réel et ce qui serait écrit
node scripts/db/propose-quartier-centroids.mjs

# 2. Écriture, seulement si le §2 a été relu et validé humainement
node scripts/db/propose-quartier-centroids.mjs --apply
```

Il ne touche **jamais** un quartier qui a déjà un centroïde, et n'écrit rien
sur les sept classés `UNKNOWN`.

## 4. Ce qu'il ne faut pas faire

- **Compléter les douze pour avoir un tableau propre.** Un quartier sans
  centroïde dégrade en `UNKNOWN`, ce que les quatre clients savent afficher.
  Un quartier avec un mauvais centroïde produit une carte qui a l'air juste.
- **Rejouer un géocodage Google et prendre le premier résultat.** Le géocodage
  inverse rend un Plus Code trois fois sur cinq à Brazzaville, et « Avenue de
  la Paix, Brazzaville » résout à **Kinshasa**.
- **Écrire les centroïdes dans une migration.** Une migration s'applique sans
  relecture. Ces valeurs demandent un arbitrage : elles passent par l'endpoint
  admin, qui les trace.

## 5. Vérifier la production

```bash
# nombre réel de quartiers et de centroïdes en base
node scripts/db/propose-quartier-centroids.mjs
```

Attendu si la migration a porté : 26 quartiers, 14 centroïdes. Tout autre
chiffre signifie que les `UPDATE` conditionnés sur le nom n'ont pas trouvé
leurs lignes — vérifier alors les accents (`Ouenzé`, `Talangaï`, `Makélékélé`).
