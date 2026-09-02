# Clés Google Maps — inventaire et cloisonnement

**Dernière vérification : 2 septembre 2026.**

> 🔴 **La clé A est publiquement lisible sur Internet à cet instant.** Ce n'est
> pas une exposition théorique : voir §2 bis. Sa rotation est la première
> action à mener, avant tout le reste de ce document.

Ce document est la référence unique pour les clés Google Maps Platform de
Lilia Food. Les actions marquées 🔧 se font dans la **Google Cloud Console** et
ne peuvent pas être faites depuis le dépôt.

---

## 1. Pourquoi il faut six clés et non deux

Une clé Google Maps Platform n'accepte qu'**un seul type de restriction
d'application** : applications Android **ou** applications iOS **ou** referrers
HTTP **ou** adresses IP. Il n'existe pas de clé « Android + iOS ».

Conséquence directe : partager une clé entre deux plateformes n'a que deux
issues, toutes deux mauvaises.

| Si la clé est… | Alors… |
|---|---|
| restreinte à Android | l'app iOS affiche une carte grise |
| restreinte à iOS | l'app Android affiche une carte grise |
| **non restreinte** | les deux marchent, et n'importe qui peut extraire la clé d'un APK et facturer au compte Lilia |

L'état constaté le 1er septembre 2026 était le troisième cas pour l'une des
deux clés en service.

## 2. État constaté avant correction

Deux clés couvraient six emplacements, chacune servant Android **et** iOS :

| Emplacement | Clé | Restriction constatée |
|---|---|---|
| `lilia-app` Android | A | restriction d'API présente |
| `lilia-app` iOS | A | idem |
| `lilia_food_delivery` iOS | A | idem |
| `lilia_food_delivery` Android | B | **aucune** |
| `lilia-food-admin` Android | B | **aucune** |
| `lilia-food-admin` iOS | B | **aucune** |

Vérification : un appel `Geocoding API` depuis une machine tierce, avec la
clé B, a été **accepté**. Aucune restriction d'application, aucune restriction
d'API. La clé B est présente en clair dans trois binaires distribués.

**Sonde rejouée le 02/09/2026 — rien n'a changé.** La clé A répond
`REQUEST_DENIED` (restriction d'API présente), la clé B répond `OK`.

⚠️ La clé A n'est pas « à moitié protégée » pour autant. Elle sert
simultanément Android et iOS ; une clé Google n'acceptant qu'**un seul** type
de restriction d'application, elle ne peut en avoir **aucune**. Sa restriction
d'API limite les dégâts à ce que les SDK Maps savent facturer — pas à zéro.

## 2 bis. Exposition publique de la clé A — mesurée le 02/09/2026

L'audit du 01/08 parlait de « trois commits ». Le compte réel est plus large,
et le dépôt est public.

| Constat | Mesure |
|---|---|
| Commits de `lilia-app` contenant la clé A | **68** (`ios/Runner/AppDelegate.swift`) et **37** (`android/app/src/main/AndroidManifest.xml`) |
| Dernier commit porteur | `153e182`, 13/06/2026 |
| Présente dans `HEAD` | non — le correctif d'août a bien fonctionné |
| Commits poussés sur `origin` | **oui**, sur au moins trois branches distantes |
| Visibilité du dépôt GitHub | **public** (`api.github.com` répond 200 sans authentification, `private: false`) |
| Lecture anonyme de la clé | **confirmée** via `raw.githubusercontent.com` |

Les cinq dépôts sont publics, mais la clé n'apparaît que dans `lilia-app`.

**Conséquence** : retirer un secret du commit courant ne le retire pas de
l'historique, et un dépôt public rend cet historique interrogeable par
n'importe qui — y compris par les robots qui scannent GitHub en continu pour
des clés d'API. La clé A doit être considérée comme compromise et **rotée**,
pas seulement restreinte. Réécrire l'historique (`git filter-repo`) ne suffit
pas non plus : GitHub conserve les objets orphelins, et des copies peuvent
déjà exister ailleurs.

**Ordre des opérations** : créer les six nouvelles clés → les câbler → vérifier
les six combinaisons → **puis** supprimer A et B. Révoquer avant de vérifier
donne une carte grise en production, qu'on ne découvre qu'en testant.

## 3. Cible

Six clés, une par couple (application, plateforme). Aucune n'est partagée.

| # | Clé | Restriction d'application | API autorisées |
|---|---|---|---|
| 1 | `lilia-app-android` | Applications Android — `com.dreesis.lilia.lilia_app` + SHA-256 | Maps SDK for Android |
| 2 | `lilia-app-ios` | Applications iOS — `com.dreesis.lilia.liliaApp` | Maps SDK for iOS |
| 3 | `delivery-android` | Applications Android — package + SHA-256 | Maps SDK for Android |
| 4 | `delivery-ios` | Applications iOS — bundle ID | Maps SDK for iOS |
| 5 | `admin-android` | Applications Android — `com.dreesis.lilia_admin` + SHA-256 | Maps SDK for Android |
| 6 | `admin-ios` | Applications iOS — bundle ID | Maps SDK for iOS |

**Aucune clé côté backend.** Le serveur n'appelle aucune API Google : l'ETA est
calculé en Haversine localement, et il n'y a ni géocodage, ni Directions, ni
Places. Ne pas en créer « au cas où » — une clé serveur non restreinte par IP
est le pire des cas.

**Aucune clé côté web.** `lilia-food-web` n'affiche aucune carte. Le jour où il
en affichera une, il lui faudra une septième clé restreinte par **referrers
HTTP** (`liliafood.com`, `www.liliafood.com`, `*.vercel.app` pour les
prévisualisations).

### 🔧 Empreintes Android — relevées le 02/09/2026

Une empreinte de certificat n'est pas un secret : c'est un condensat public,
et c'est exactement ce que la console Google Cloud demande.

| Clé à restreindre | `applicationId` | Empreinte SHA-256 du keystore d'**upload** |
|---|---|---|
| `lilia-app-android` | `com.dreesis.lilia.lilia_app` | `69:8A:E8:BF:63:04:8B:5C:1D:4C:05:2E:8A:C3:79:4A:BF:10:F3:02:4E:0A:C6:F1:C6:88:86:67:62:20:B3:79` |
| `delivery-android` | `com.dreesis.lilia_food_delivery` | `1C:9C:DD:8F:C7:E8:73:11:ED:52:3A:49:6B:BE:00:A3:20:2F:1F:5A:85:54:F2:59:33:D4:08:55:B6:BA:3F:F0` |
| `admin-android` | `com.dreesis.lilia_admin` | **aucun keystore de release** — voir ci-dessous |

Empreinte du keystore de debug de ce poste (à ajouter si l'on veut des cartes
en `flutter run`) :
`CA:76:DB:36:03:E9:A7:79:2E:9B:56:77:8B:44:7A:8E:97:CE:54:2B:23:09:86:95:7E:07:70:46:9C:55:FD:CC`

⚠️ **`lilia-food-admin` n'a pas de `android/key.properties`.** Son
`build.gradle.kts` retombe alors sur `signingConfigs.getByName("debug")` : l'AAB
de release est signé avec la **clé de debug d'Android, qui est publique**. Il
est inpubliable sur le Play Store, et n'importe qui peut fabriquer une mise à
jour que les appareils accepteront. Créer son keystore d'upload est un
préalable à toute restriction de la clé `admin-android`.

⚠️ **`lilia_food_delivery` déclare `signingConfig = signingConfigs.getByName("release")`
inconditionnellement**, alors que le bloc lit `keystoreProperties["keyAlias"] as String`.
Sans `key.properties`, le chargement Gradle échoue au lieu de retomber sur le
debug. C'est plus honnête que le silence, mais un poste de dev sans keystore ne
peut faire aucun `--release`, y compris pour tester Maps.

### 🔧 Empreintes Android — le piège

Chaque clé Android doit lister **deux** empreintes SHA-256, pas une :

1. celle du keystore d'upload (`upload-keystore.jks`) — utilisée en local et
   pour signer l'AAB envoyé au Play Store ;
2. celle de **Play App Signing** — la clé avec laquelle Google **resigne**
   l'application avant distribution. Elle se trouve dans la console Play, sous
   *Configuration → Intégrité de l'app*.

N'enregistrer que la première donne une carte qui fonctionne en local, en
interne, en test fermé… et **grise sur l'application publiée**. C'est le
symptôme « ça marche en debug, pas en production » le plus fréquent avec Maps.

Ajouter aussi l'empreinte du keystore de debug de chaque poste de
développement, ou accepter que les cartes ne s'affichent qu'en release.

### 🔧 Restriction d'API

Sur chacune des six clés : **une seule** API autorisée (Maps SDK Android ou
Maps SDK iOS). Pas de Geocoding, pas de Places, pas de Directions — le produit
ne les appelle pas, et une clé extraite ne doit rien pouvoir faire d'autre
qu'afficher des tuiles.

### 🔧 Plafonds et alertes

Sans plafond, une clé fuitée se facture jusqu'à la limite du moyen de paiement.
À configurer dans *Facturation → Budgets et alertes* :

- un budget mensuel avec alertes à 50 %, 90 % et 100 % ;
- des quotas par API (*APIs & Services → Quotas*) calibrés sur le trafic réel,
  pas sur le maximum imaginable.

### 🔧 Révocation

**Après** avoir vérifié que les six nouvelles clés fonctionnent sur les six
combinaisons (application × plateforme × configuration de build), supprimer les
clés A et B. Pas avant : une empreinte oubliée se traduit par une carte grise
en production, et la seule façon de s'en apercevoir est de tester.

## 4. Où vit chaque clé dans le dépôt

Les trois applications utilisent désormais le **même mécanisme** — elles en
avaient trois différents, dont le plus fragile lisait un fichier de ressources
Android gitignoré et sans gabarit.

### Android

`android/local.properties` (gitignoré) :

```properties
MAPS_API_KEY=<la clé de cette app pour Android>
```

Lue par `android/app/build.gradle.kts`, injectée dans le manifeste via
`manifestPlaceholders["MAPS_API_KEY"]`. La variable d'environnement du même nom
est également acceptée, pour une CI.

⚠️ Ce dernier point était **écrit ici mais faux pour `lilia-app`**, dont le
Gradle ne lisait que `local.properties` : aucun pipeline ne pouvait produire sa
release, il butait sur la garde qui refuse un binaire sans clé. Corrigé le
02/09/2026 — les trois apps acceptent désormais les deux sources.

⚠️ `lilia_food_delivery` utilise historiquement la clé `googleMapsApiKey` (et
`GOOGLE_MAPS_API_KEY` en environnement) — même mécanisme, nom différent.

### iOS

`ios/Flutter/MapsKeys.local.xcconfig` (gitignoré) :

```
GOOGLE_MAPS_API_KEY=<la clé de cette app pour iOS>
```

Un gabarit `MapsKeys.xcconfig` est committé avec une valeur bidon ; le fichier
local l'écrase via `#include?`. `Info.plist` lit `$(GOOGLE_MAPS_API_KEY)` et
`AppDelegate.swift` la récupère depuis le bundle.

⚠️ `lilia-food-admin` ne suivait **pas** ce mécanisme, contrairement à ce que
cette section affirmait : il lisait `ios/Flutter/Maps.xcconfig`, sans gabarit
committé, pendant que son `AppDelegate` renvoyait le développeur vers
`MapsKeys.local.xcconfig` — un fichier que rien n'incluait. Sur un poste neuf,
suivre le message d'erreur ne réparait donc rien. Aligné le 02/09/2026 :
`Maps.xcconfig` renommé, gabarit ajouté, `.gitignore` mis à jour.

### Ce qui se passe si la clé manque

| Plateforme | Avant | Maintenant |
|---|---|---|
| Android | carte grise, aucune erreur | **le build de release échoue** avec la marche à suivre ; debug inchangé |
| iOS | **crash** à l'ouverture du premier écran de carte, sans rapport apparent | `fatalError` au démarrage en release avec la marche à suivre ; log en debug |

Le comportement iOS mérite d'être souligné : ne pas appeler
`GMSServices.provideAPIKey` ne dégrade pas l'affichage, cela fait lever une
exception fatale par le SDK à la première `GMSMapView`. Un développeur voyait
donc l'application crasher sur l'écran de suivi, longtemps après le démarrage.

## 5. Vérification

Pour savoir si une clé est restreinte, sans passer par la console :

```bash
curl -s "https://maps.googleapis.com/maps/api/geocode/json?latlng=-4.2634,15.2429&key=$KEY" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'), d.get('error_message',''))"
```

- `REQUEST_DENIED` + message sur les restrictions d'API → la clé est bornée ✅
- `OK` → **la clé n'a aucune restriction** ❌

Les SDK Maps Android/iOS ne sont pas des API REST : cette sonde ne dit rien de
la restriction d'application. Pour celle-là, il faut installer un binaire signé
et regarder la carte.
