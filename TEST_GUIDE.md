# Guide de Test - Lilia Food Backend

Ce document contient tous les tests à effectuer pour les nouvelles fonctionnalités.

## 🔧 Prérequis

1. **Démarrer le serveur** :
```bash
cd C:\Users\fatak\lilia-app
npm run start:dev
```

2. **Obtenir un Token Firebase** :
   - Connectez-vous à l'application mobile ou utilisez Firebase Console
   - Récupérez votre ID Token
   - Ce token sera utilisé dans l'en-tête `Authorization: Bearer <token>`

3. **Base URL** : `http://localhost:3000` (ou votre port configuré)

---

## 📋 Tests des Menus (MenuDuJour)

### ✅ Test 1 : Créer un Menu (Restaurateur)

**Endpoint** : `POST /menus`
**Auth** : Bearer Token (Restaurateur uniquement)

**Body** :
```json
{
  "nom": "Menu du Jour - Test",
  "description": "Menu spécial pour les tests",
  "prix": 5000,
  "imageUrl": "https://example.com/menu-test.jpg",
  "dateDebut": "2026-01-15T08:00:00Z",
  "dateFin": "2026-01-15T22:00:00Z",
  "isActive": true,
  "products": [
    {
      "productId": "<PRODUCT_ID_1>",
      "ordre": 1
    },
    {
      "productId": "<PRODUCT_ID_2>",
      "ordre": 2
    }
  ]
}
```

**Attendu** :
- ✅ Status 201
- ✅ Menu créé avec tous les détails
- ✅ Événement `menu.created` émis
- ✅ Notifications FCM envoyées aux clients précédents (vérifier les logs)

**À vérifier dans les logs** :
```
📢 Emitting menu.created event for menu: <menu_id>
🔥 Handling menu created event: <menu_id> - Menu du Jour - Test
📊 Found X previous customers for restaurant <restaurant_id>
✅ Menu creation notifications sent: X succeeded, 0 failed
```

---

### ✅ Test 2 : Lister Tous les Menus

**Endpoint** : `GET /menus`
**Auth** : Aucune (public)
**Query Params** : Optionnels
- `restaurantId` : Filtrer par restaurant
- `isActive` : true/false
- `includeExpired` : true/false

**Exemples** :
```
GET /menus
GET /menus?restaurantId=<restaurant_id>
GET /menus?isActive=true
GET /menus?includeExpired=true
```

**Attendu** :
- ✅ Status 200
- ✅ Liste des menus avec filtres appliqués
- ✅ Par défaut, les menus expirés sont exclus

---

### ✅ Test 3 : Récupérer les Menus Actifs

**Endpoint** : `GET /menus/active`
**Auth** : Aucune (public)
**Query Params** : `restaurantId` (optionnel)

**Exemple** :
```
GET /menus/active
GET /menus/active?restaurantId=<restaurant_id>
```

**Attendu** :
- ✅ Status 200
- ✅ Uniquement les menus actifs (isActive=true) et dans leur période de validité
- ✅ Menus triés par date de début (plus récents en premier)

---

### ✅ Test 4 : Récupérer Mes Menus (Restaurateur)

**Endpoint** : `GET /menus/restaurant`
**Auth** : Bearer Token (Restaurateur uniquement)

**Attendu** :
- ✅ Status 200
- ✅ Tous les menus du restaurant de l'utilisateur connecté
- ✅ Inclut les menus actifs ET inactifs
- ✅ Inclut les menus expirés

---

### ✅ Test 5 : Récupérer un Menu par ID

**Endpoint** : `GET /menus/:id`
**Auth** : Aucune (public)

**Exemple** :
```
GET /menus/<menu_id>
```

**Attendu** :
- ✅ Status 200
- ✅ Détails complets du menu avec produits, variantes et restaurant
- ✅ Produits ordonnés selon le champ `ordre`

---

### ✅ Test 6 : Mettre à Jour un Menu (Restaurateur)

**Endpoint** : `PATCH /menus/:id`
**Auth** : Bearer Token (Restaurateur, propriétaire uniquement)

**Body** : (tous les champs sont optionnels)
```json
{
  "nom": "Menu Modifié",
  "prix": 4500,
  "isActive": false,
  "products": [
    {
      "productId": "<NEW_PRODUCT_ID>",
      "ordre": 1
    }
  ]
}
```

**Attendu** :
- ✅ Status 200
- ✅ Menu mis à jour
- ✅ Si `products` fourni, anciennes relations supprimées et nouvelles créées
- ✅ Erreur 403 si l'utilisateur n'est pas le propriétaire

---

### ✅ Test 7 : Activer/Désactiver un Menu (Toggle)

**Endpoint** : `PATCH /menus/:id/toggle`
**Auth** : Bearer Token (Restaurateur, propriétaire uniquement)

**Attendu** :
- ✅ Status 200
- ✅ Champ `isActive` inversé
- ✅ Message : "Menu activé avec succès" ou "Menu désactivé avec succès"

---

### ✅ Test 8 : Supprimer un Menu (Restaurateur)

**Endpoint** : `DELETE /menus/:id`
**Auth** : Bearer Token (Restaurateur, propriétaire uniquement)

**Attendu** :
- ✅ Status 200
- ✅ Menu supprimé (cascade sur MenuProduct)
- ✅ Message : "Menu supprimé avec succès"
- ✅ Erreur 403 si l'utilisateur n'est pas le propriétaire

---

### ❌ Tests d'Erreurs - Menus

#### Test 9 : Dates invalides
**Body** :
```json
{
  "nom": "Menu Test",
  "prix": 5000,
  "dateDebut": "2026-01-15T20:00:00Z",
  "dateFin": "2026-01-15T08:00:00Z",
  "products": [...]
}
```

**Attendu** :
- ✅ Status 400
- ✅ Message : "La date de fin doit être après la date de début."

---

#### Test 10 : Produits invalides
**Body** :
```json
{
  "nom": "Menu Test",
  "prix": 5000,
  "dateDebut": "2026-01-15T08:00:00Z",
  "dateFin": "2026-01-15T20:00:00Z",
  "products": [
    {
      "productId": "invalid-product-id",
      "ordre": 1
    }
  ]
}
```

**Attendu** :
- ✅ Status 400
- ✅ Message : "Certains produits n'existent pas ou n'appartiennent pas à votre restaurant."

---

#### Test 11 : Créer un menu sans être restaurateur
**Auth** : Token d'un CLIENT

**Attendu** :
- ✅ Status 403
- ✅ Message : "Vous devez posséder un restaurant pour créer un menu."

---

## 🔄 Tests du Reorder (Commander à Nouveau)

### ✅ Test 12 : Recommander une Commande (Panier Vide)

**Prérequis** :
1. Avoir une commande complétée dans l'historique
2. Avoir le panier vide

**Endpoint** : `POST /orders/:orderId/reorder`
**Auth** : Bearer Token (CLIENT)

**Exemple** :
```
POST /orders/<order_id>/reorder
```

**Attendu** :
- ✅ Status 201
- ✅ Tous les produits de la commande ajoutés au panier
- ✅ Summary : `totalAdded`, `totalUnavailable`, `totalErrors`
- ✅ Details : liste des produits ajoutés/indisponibles
- ✅ Panier retourné avec les nouveaux items

**Réponse Exemple** :
```json
{
  "message": "Commande ajoutée au panier avec succès",
  "cart": {
    "id": "cart123",
    "items": [...]
  },
  "summary": {
    "totalAdded": 3,
    "totalUnavailable": 0,
    "totalErrors": 0
  },
  "details": {
    "added": [
      { "productName": "Poulet Braisé", "variant": "Grande", "quantity": 2 }
    ],
    "unavailable": [],
    "errors": []
  }
}
```

---

### ✅ Test 13 : Recommander avec Panier Existant (Même Restaurant)

**Prérequis** :
1. Avoir déjà des items dans le panier du même restaurant
2. Recommander une commande du même restaurant

**Attendu** :
- ✅ Status 201
- ✅ Quantités additionnées si le même produit existe déjà
- ✅ Nouveaux produits ajoutés

---

### ❌ Test 14 : Recommander avec Panier d'un Autre Restaurant

**Prérequis** :
1. Avoir des items dans le panier du Restaurant A
2. Recommander une commande du Restaurant B

**Attendu** :
- ✅ Status 400
- ✅ Message : "Votre panier contient déjà des articles de [Restaurant A]. Veuillez vider votre panier..."

---

### ❌ Test 15 : Recommander une Commande qui ne nous appartient pas

**Endpoint** : `POST /orders/<other_user_order_id>/reorder`
**Auth** : Bearer Token (CLIENT différent)

**Attendu** :
- ✅ Status 403
- ✅ Message : "Cette commande ne vous appartient pas."

---

### ❌ Test 16 : Recommander avec Produits Indisponibles

**Prérequis** :
1. Avoir une ancienne commande avec des produits supprimés/désactivés

**Attendu** :
- ✅ Status 201 (succès partiel)
- ✅ Summary : `totalUnavailable > 0`
- ✅ Details.unavailable : liste des produits non disponibles avec raisons

---

## 🧪 Tests de la Compilation

### ✅ Test 17 : Compilation TypeScript

**Commande** :
```bash
npm run build
```

**Attendu** :
- ✅ Aucune erreur TypeScript
- ✅ Build réussi
- ✅ Dossier `dist/` créé

---

### ✅ Test 18 : Linter

**Commande** :
```bash
npm run lint
```

**Attendu** :
- ✅ Aucune erreur ESLint critique
- ⚠️ Warnings acceptables

---

## 📊 Tests de la Base de Données

### ✅ Test 19 : Vérifier les Migrations

**Commande** :
```bash
npx prisma migrate status
```

**Attendu** :
- ✅ "Database schema is up to date!"
- ✅ Migration `add_menu_features` appliquée

---

### ✅ Test 20 : Prisma Studio (Vérification Visuelle)

**Commande** :
```bash
npx prisma studio
```

**À vérifier** :
- ✅ Table `MenuDuJour` existe
- ✅ Table `MenuProduct` existe
- ✅ Relations correctes entre les tables
- ✅ Données de test visibles

---

## 📝 Checklist de Test Complète

### Menus
- [ ] Créer un menu (avec notifications)
- [ ] Lister tous les menus
- [ ] Récupérer menus actifs
- [ ] Récupérer mes menus (restaurateur)
- [ ] Récupérer un menu par ID
- [ ] Mettre à jour un menu
- [ ] Toggle actif/inactif
- [ ] Supprimer un menu
- [ ] Erreur : dates invalides
- [ ] Erreur : produits invalides
- [ ] Erreur : non-restaurateur

### Reorder
- [ ] Recommander avec panier vide
- [ ] Recommander avec panier existant (même restaurant)
- [ ] Erreur : panier d'un autre restaurant
- [ ] Erreur : commande d'un autre utilisateur
- [ ] Gestion produits indisponibles

### Infrastructure
- [ ] Compilation réussie
- [ ] Linter OK
- [ ] Migrations appliquées
- [ ] Prisma Studio fonctionne

---

## 🎯 Notes Importantes

1. **Logs à surveiller** :
   - Événements émis (menu.created)
   - Notifications envoyées
   - Erreurs de variantes manquantes (reorder)

2. **Variables d'environnement requises** :
   - Firebase credentials
   - Database URL
   - Cloudinary (pour images)

3. **Postman Collection** :
   - Importez ce fichier de test dans Postman
   - Créez un environnement avec vos variables (token, IDs)

4. **Swagger Documentation** :
   - Accessible à : `http://localhost:3000/api`
   - Tester directement depuis l'interface Swagger

---

## 🐛 Problèmes Courants

### Erreur : "Prisma Client Out of Sync"
**Solution** :
```bash
npx prisma generate
```

### Erreur : "Firebase not initialized"
**Solution** :
- Vérifier les credentials Firebase dans `.env`
- Vérifier que le service account est valide

### Erreur : "Unauthorized"
**Solution** :
- Vérifier que le token Firebase est valide
- Vérifier l'en-tête : `Authorization: Bearer <token>`
- Vérifier que l'utilisateur existe dans la base de données

---

**Bon test ! 🚀**
