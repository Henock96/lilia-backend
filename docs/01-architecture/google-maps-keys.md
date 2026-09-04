# Clés Google Maps — inventaire et cloisonnement

**Dernière vérification : 4 septembre 2026.**

> ✅ **La cible de six clés est atteinte, et les six sont restreintes.**
> Mesuré le 04/09/2026 par la sonde du §5 — voir §0. La rotation demandée par
> l'audit du 01/08 a été effectuée.
>
> 🟠 **Reste ouvert** : les six anciennes valeurs restent lisibles dans
> l'historique public des dépôts (§2 bis). Une clé remplacée n'est inoffensive
> que si l'ancienne a été **révoquée** en console, pas seulement remplacée
> dans le code.

Ce document est la référence unique pour les clés Google Maps Platform de
Lilia Food. Les actions marquées 🔧 se font dans la **Google Cloud Console** et
ne peuvent pas être faites depuis le dépôt.

---

## 0. État au 4 septembre 2026 — mesuré

Six clés distinctes sont en service, une par couple (application, plateforme) —
exactement la cible du §3. La sonde du §5, rejouée sur chacune depuis une
machine tierce :

| Emplacement | Clé (6 derniers car.) | Sonde Geocoding |
|---|---|---|
| `lilia-app` Android | `…p0od_w` | `REQUEST_DENIED` ✅ |
| `lilia-app` iOS | `…mCycho` | `REQUEST_DENIED` ✅ |
| `lilia-food-admin` Android | `…bVEcCc` | `REQUEST_DENIED` ✅ |
| `lilia-food-admin` iOS | `…UmKTGw` | `REQUEST_DENIED` ✅ |
| `lilia_food_delivery` Android | `…Wmqa44` | `REQUEST_DENIED` ✅ |
| `lilia_food_delivery` iOS | `…rBYTBQ` | `REQUEST_DENIED` ✅ |

**Changement par rapport au 02/09** : la clé B, alors totalement non restreinte
(`OK` depuis une machine tierce, présente en clair dans trois binaires), n'est
plus en service. Aucune des six clés actuelles n'accepte un appel REST anonyme.

⚠️ **Ce que cette mesure ne dit PAS.** Elle prouve la présence d'une
restriction d'**API**, pas d'une restriction d'**application** : les SDK Maps
Android/iOS ne passent pas par l'API REST, une clé peut donc répondre
`REQUEST_DENIED` ici tout en étant utilisable par n'importe quel binaire. Il
reste à vérifier en console, pour chacune :

- 🔧 restriction d'application posée (package + SHA-1 **de release**, y compris
  l'empreinte **Play App Signing** — cf. §3) ;
- 🔧 restriction d'API limitée aux seules API réellement utilisées ;
- 🔧 budget et quotas ;
- 🔧 **révocation** des deux clés historiques A et B, toujours lisibles dans
  l'historique public des dépôts.

Tant que la révocation n'est pas faite, l'exposition du §2 bis reste ouverte :
remplacer une clé dans le code ne désactive pas l'ancienne.


### Empreintes SHA-1 des certificats de **release** — relevées le 04/09/2026

Nécessaires pour poser la restriction d'application Android sur chaque clé.
Relevées sur les APK réellement produits par `flutter build apk --release`
(`apksigner verify --print-certs`), donc sur les certificats effectivement
utilisés — pas sur ce qu'un fichier de configuration prétend.

| Application | `applicationId` | SHA-1 du certificat de release |
|---|---|---|
| `lilia-app` | `com.dreesis.lilia.lilia_app` | `1A:02:EE:67:65:E3:7A:52:01:E4:A0:56:4F:AB:37:98:48:85:48:DD` |
| `lilia-food-admin` | `com.dreesis.lilia_admin` | `37:E9:1B:CA:6E:C6:9C:62:90:14:46:C9:07:D6:1F:BA:60:91:B2:EC` |
| `lilia_food_delivery` | `com.dreesis.lilia_food_delivery` | `49:AD:2B:60:C4:42:47:C9:59:D7:67:A1:42:C6:16:C8:23:75:11:5D` |

La restriction d'application Android d'une clé Maps se déclare en **SHA-1** —
c'est ce que demande la console Google Cloud, là où la Play Console affiche des
SHA-256. Les deux coexistent, ne pas les confondre.

Les trois APK sont signés par un certificat **DreesisLab / Brazzaville**, et non
par la clé de debug d'Android (`CN=Android Debug, O=Android, C=US`) — le défaut
M-6 de l'audit d'août 2026 est bien refermé.

🔧 **Le piège Play App Signing.** Si Google signe les artefacts à votre place,
l'empreinte que voient les appareils n'est **pas** celle ci-dessus mais celle du
certificat de la *Play Console* (Configuration → Intégrité de l'application).
Il faut alors déclarer **les deux** sur chaque clé Android : celle du dépôt pour
les installations directes, celle de Google pour les installations depuis le
Store. N'en déclarer qu'une produit une carte grise sur la moitié du parc, sans
message d'erreur.

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

## 2. État constaté avant correction (01–02/09/2026)

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

> ⚠️ **Partiellement périmé — voir §0.** Au 04/09/2026, les trois applications
> possèdent un `android/key.properties` et les trois APK de release sont signés
> par un certificat DreesisLab. La réserve ci-dessous sur `lilia-food-admin`
> (« aucun keystore de release ») **n'est plus vraie**. Les empreintes SHA-1
> effectivement portées par les binaires produits sont au §0.

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
