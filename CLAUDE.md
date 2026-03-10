# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview: Lilia Food

Lilia Food is a complete food delivery platform consisting of three main components:
1. **Backend API** (NestJS + Prisma + PostgreSQL + Firebase Admin SDK)
2. **Client Mobile App** (Flutter + Riverpod)
3. **Admin Dashboard** (Flutter + Riverpod)

All components communicate through a RESTful API with Firebase Authentication providing identity management.

---

## Backend - NestJS API

**Location**: `C:\Users\fatak\lilia-app`

### Development Commands

```bash
# Install dependencies
npm install

# Development mode with hot reload
npm run start:dev

# Build for production
npm run build

# Run production build
npm run start:prod

# Run tests
npm run test
npm run test:watch
npm run test:e2e

# Lint and format
npm run lint
npm run format

# Prisma commands
npx prisma generate              # Generate Prisma client
npx prisma migrate dev           # Create and apply migration
npx prisma migrate deploy        # Apply migrations in production
npx prisma studio                # Open Prisma Studio GUI

# Full deployment build (for Render)
npm run render-build
```

### Architecture

#### Tech Stack
- **Framework**: NestJS 11.x
- **Database**: PostgreSQL via Prisma ORM
- **Authentication**: Firebase Admin SDK for token verification
- **File Storage**: Cloudinary for image uploads
- **SMS**: Twilio integration
- **Payments**: MTN Mobile Money integration
- **Real-time**: EventEmitter for order/payment events
- **Cron Jobs**: @nestjs/schedule pour les taches planifiees (horaires d'ouverture)
- **API Documentation**: Swagger/OpenAPI

#### Module Structure
The backend follows NestJS modular architecture:

```
src/
├── auth/              # Firebase authentication middleware
├── users/             # User management (sync with Firebase)
├── restaurants/       # Restaurant CRUD operations
├── products/          # Product catalog management
├── categories/        # Product categories
├── menus/             # Daily menu management (CRUD + notifications)
├── cart/              # Shopping cart operations
├── orders/            # Order management + SSE streams
├── deliveries/        # Delivery assignment and tracking
├── adresses/          # User addresses
├── payments/          # MTN MoMo payment processing
├── notifications/     # FCM push notifications + SSE
├── cloudinary/        # Image upload service
├── sms/               # Twilio SMS service
├── firebase/          # Firebase Admin SDK setup
├── prisma/            # Prisma service (global)
├── health/            # Health check endpoint
├── schedule/          # Cron jobs (mise a jour auto isOpen selon horaires)
├── events/            # Event definitions (orders, payments, menus)
└── listeners/         # Event listeners (orders, payments, menus)
```

#### Database Schema Overview (Prisma)

Key models and relationships:
- **User**: Links Firebase UID to app data, has role (ADMIN, RESTAURATEUR, LIVREUR, CLIENT)
- **Restaurant**: Owned by a User with RESTAURATEUR role
- **Product**: Belongs to Restaurant and Category, has ProductVariants
- **ProductVariant**: Different sizes/options for products (30cl, 1.5L, etc.)
- **MenuDuJour**: Daily/special menus for restaurants with validity dates. Supports two types via `MenuType` enum: `COMBO` (multi-produits existants) and `PLAT_SPECIAL` (plat unique temporaire avec produit phantom auto-cree). Champs: `type`, `ingredients` (composition texte libre pour PLAT_SPECIAL)
- **MenuProduct**: Junction table for many-to-many relationship between MenuDuJour and Product
- **Cart**: One per user, contains CartItems
- **CartItem**: Links Product + ProductVariant with quantity (can also link to MenuDuJour)
- **Order**: Placed by user, belongs to restaurant, has OrderItems
- **OrderItem**: Snapshot of product/variant/price at order time (can also link to MenuDuJour)
- **Delivery**: One per order, tracks delivery status and deliverer
- **Payment**: Tracks MTN MoMo payment transactions
- **Adresses**: User's saved addresses
- **FcmToken**: Firebase Cloud Messaging tokens for push notifications
- **OperatingHours**: Horaires d'ouverture par jour de la semaine (Lundi-Dimanche) pour chaque restaurant. Contrainte unique sur [restaurantId, dayOfWeek]. Champs: openTime/closeTime (format "HH:mm"), isClosed (jour ferme), dayOfWeek (enum DayOfWeek)
- **Restaurant.manualOverride**: Si true, le cron job ne modifie pas le champ isOpen (toggle manuel prioritaire)

#### Authentication Flow
1. Client authenticates with Firebase (client-side)
2. Client sends Firebase ID token in `Authorization: Bearer <token>` header
3. Backend verifies token with Firebase Admin SDK
4. If valid, extracts `firebaseUid` and finds/creates User in database
5. Endpoints are protected by guards that check authentication and roles

#### Key Endpoints

**Auth**: No explicit auth endpoints (handled by Firebase on client)
- Backend auto-registers users via `/auth/register` when they first authenticate

**Orders**:
- `GET /orders/restaurants` - Get all orders for restaurant owner
- `GET /orders/user` - Get orders for current user
- `PATCH /orders/:id/status` - Update order status (admin/restaurant)
- Real-time updates via Server-Sent Events (SSE)

**Cart**:
- `GET /cart` - Get current user's cart
- `POST /cart/items` - Add item to cart
- `PATCH /cart/items/:id` - Update cart item quantity
- `DELETE /cart/items/:id` - Remove item from cart

**Restaurants**:
- `GET /restaurants` - Liste tous les restaurants (inclut operatingHours)
- `GET /restaurants/:id` - Details d'un restaurant avec produits et horaires
- `GET /restaurants/mine` - Restaurant du proprietaire connecte (RESTAURATEUR/ADMIN)
- `PATCH /restaurants/:id` - Modifier infos generales du restaurant
- `PATCH /restaurants/:id/open-status` - Toggle ouvert/ferme (active manualOverride)
- `PATCH /restaurants/:id/delivery-settings` - Parametres de livraison

**Horaires d'ouverture** (Operating Hours):
- `GET /restaurants/:id/operating-hours` - Recuperer les horaires (public)
- `PUT /restaurants/:id/operating-hours` - Definir les horaires de la semaine en bulk (RESTAURATEUR/ADMIN, desactive manualOverride)
- `PATCH /restaurants/:id/operating-hours/:dayOfWeek` - Modifier un seul jour (RESTAURATEUR/ADMIN)

**Products**:
- `GET /products` - List products (with filters)
- `POST /products` - Create product (restaurant owner)
- `PATCH /products/:id` - Update product
- `DELETE /products/:id` - Delete product

**Menus** (Daily/Special Menus):
- `POST /menus` - Create menu (restaurant owner)
- `GET /menus` - List all menus (with filters: restaurantId, isActive, includeExpired)
- `GET /menus/active` - Get active menus for today (optionally filtered by restaurant)
- `GET /menus/restaurant` - Get all menus for authenticated restaurant owner
- `GET /menus/:id` - Get menu details with products
- `PATCH /menus/:id` - Update menu (restaurant owner)
- `PATCH /menus/:id/toggle` - Activate/deactivate menu (restaurant owner)
- `DELETE /menus/:id` - Delete menu (restaurant owner)

**Notifications**:
- `POST /notifications/register-token` - Register FCM token
- `GET /notifications/sse` - SSE endpoint for real-time order updates

**Payments**:
- `POST /payments/initiate` - Initiate MTN MoMo payment
- `POST /payments/webhook` - Payment provider webhook

#### Event-Driven Architecture
The backend uses NestJS EventEmitter for decoupling:

**Events**:
- `order.created` → Send notification to restaurant and client
- `order.status.updated` → Send notification to client
- `payment.success` → Update order status to PAYER
- `menu.created` → Send push notification to all previous customers of the restaurant

**Listeners**:
- `OrdersListener` (src/listeners/orders.listener.ts) - Handles order events
- `PaymentListener` (src/listeners/payment.listener.ts) - Handles payment events
- `MenusListener` (src/listeners/menus.listener.ts) - Handles menu events and sends notifications

#### Environment Variables Required
```
DATABASE_URL=postgresql://...
FIREBASE_PROJECT_ID=...
FIREBASE_PRIVATE_KEY=...
FIREBASE_CLIENT_EMAIL=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
MTN_MOMO_API_KEY=...
MTN_MOMO_API_USER=...
```

#### Deployment
The backend is deployed on Render with the `render-build` script that:
1. Installs dependencies
2. Generates Prisma client
3. Applies migrations
4. Builds NestJS application

---

## Client Mobile App - Flutter

**Location**: `C:\Users\fatak\Desktop\dreesiscode\code\lilia_app`

### Development Commands

```bash
# Install dependencies
flutter pub get

# Generate code (Riverpod providers, routes)
dart run build_runner build --delete-conflicting-outputs

# Watch mode for development
dart run build_runner watch --delete-conflicting-outputs

# Run app
flutter run
flutter run -d <device-id>

# Build
flutter build apk              # Android APK
flutter build appbundle        # Android App Bundle
flutter build ios              # iOS build

# Update launcher icons
dart run flutter_launcher_icons

# Analyze and test
flutter analyze
flutter test
```

### Architecture

#### State Management
- **Riverpod** with code generation (`riverpod_annotation`)
- All providers use `@riverpod` annotation and generate `.g.dart` files
- Controllers manage business logic and state
- Repositories handle API calls

#### Navigation
- **go_router** with `StatefulShellRoute` for bottom navigation
- 4 main tabs: Home, Cart, Orders (Commandes), Profile
- Auth state drives automatic redirects

#### Feature Structure
```
lib/
├── features/
│   ├── auth/              # Firebase Auth + backend sync
│   ├── cart/              # Shopping cart
│   ├── commandes/         # Order management + checkout
│   ├── favoris/           # Favorites (local only)
│   ├── home/              # Restaurant browsing + products
│   ├── notifications/     # FCM push notifications
│   ├── payments/          # MTN MoMo payment
│   └── user/              # Profile + addresses
├── models/                # Data models
├── routing/               # go_router configuration
├── services/              # App-wide services
├── common_widgets/        # Reusable UI components
├── utilities/             # Themes, colors, styles
└── main.dart
```

#### Authentication Flow
1. Firebase Authentication (email/password, Google Sign-In)
2. On successful auth, sync user to backend via `/auth/register`
3. All API calls include Firebase ID token: `Authorization: Bearer <token>`
4. Auth state changes trigger navigation via `authStateChangeProvider`
5. On sign out, invalidate all user-related providers

#### Key Providers & Controllers

**Auth**:
- `authStateChangeProvider` - Watches Firebase auth state
- `authControllerProvider` - Sign in/out/up operations
- `userDataSynchronizerProvider` - Syncs Firebase user to backend

**Cart**:
- `cartControllerProvider` - Cart state and operations
- `CartRepository` - Streams cart from backend via SSE-like pattern

**Orders**:
- `orderControllerProvider` - Fetch user orders
- `checkoutControllerProvider` - Handle checkout flow
- Orders refresh when `latestUpdatedOrderIdProvider` changes (triggered by FCM)

**Restaurant**:
- `restaurantControllerProvider` - List restaurants
- `productDetailProvider` - Get product details

**Notifications**:
- `NotificationService` - Handles FCM setup and message handling
- Foreground, background, and terminated state handlers
- Registers FCM token to backend

#### API Communication
- Base URL: `https://lilia-backend.onrender.com`
- All repositories use Firebase ID token for authenticated requests
- Repositories use streams to listen for real-time updates

#### Important Notes
- **Code generation required** after modifying `@riverpod` annotated files
- Firebase must be initialized before `ProviderScope` in main.dart
- Google Sign In requires initialization: `await GoogleSignIn.instance.initialize()`
- Cart uses broadcast stream - check `_isClosed` before adding events
- Product detail navigation passes objects via `extra` parameter

---

## Admin Dashboard - Flutter

**Location**: `C:\Users\fatak\Desktop\dreesiscode\code\lilia_admin`

### Development Commands

Same as client app:
```bash
flutter pub get
dart run build_runner build --delete-conflicting-outputs
flutter run
```

### Architecture

#### Purpose
Admin dashboard for restaurant owners to:
- View incoming orders in real-time
- Update order status (EN_ATTENTE → PAYER → EN_PREPARATION → PRET → LIVRER)
- View customer list and order history
- Monitor restaurant operations

#### Tech Stack
- **Flutter** with **Riverpod** (same as client app)
- **go_router** for navigation
- **flutter_client_sse** for real-time order updates via Server-Sent Events (SSE)
- **Firebase Auth** for authentication

#### Key Features

**Real-time Order Updates**:
- Uses SSE to stream order updates from backend
- Endpoint: `GET /notifications/sse` with Authorization header
- Updates order list automatically when new orders arrive or status changes

**Feature Structure**:
```
lib/
├── features/
│   ├── auth/              # Firebase authentication
│   ├── home/              # Dashboard + order list
│   │   ├── data/
│   │   │   ├── order_service.dart      # API + SSE client
│   │   │   └── order_controller.dart   # State management
│   │   └── presentation/
│   │       └── screens/
│   │           └── restaurant_orders_screen.dart
│   ├── clients/           # Customer management
│   │   ├── data/
│   │   │   ├── client_repository.dart
│   │   │   └── user_repository.dart
│   │   └── presentation/
│   │       ├── providers/
│   │       │   ├── clients_provider.dart
│   │       │   └── user_orders_provider.dart
│   │       └── screens/
│   │           ├── clients_screen.dart
│   │           └── client_detail_screen.dart
│   └── restaurant/        # Restaurant info provider
├── models/                # Order, Client, AppUser models
├── routing/               # Router with 3 tabs
└── main.dart
```

#### Navigation Structure
3-tab bottom navigation:
1. **Commandes** (Orders) - Real-time order dashboard
2. **Clients** - Customer list and details
3. **Paramètres** (Settings) - Placeholder for future features

#### Order Status Flow
Admin can update orders through these statuses:
- `EN_ATTENTE` - New order, waiting for confirmation
- `PAYER` - Payment confirmed
- `EN_PREPARATION` - Restaurant is preparing
- `PRET` - Ready for delivery
- `LIVRER` - Delivered
- `ANNULER` - Cancelled

#### Key APIs Used
- `GET /orders/restaurants` - Fetch all orders for the restaurant
- `PATCH /orders/:id/status` - Update order status
- `GET /notifications/sse` - SSE stream for real-time updates
- `GET /users` - List all clients (filtered by restaurant)
- `GET /orders/user/:userId` - Get orders for specific client

#### SSE Integration
The `OrderService` connects to SSE endpoint:
```dart
Stream<SSEModel> getSseStream(String token) {
  return SSEClient.subscribeToSSE(
    url: '$_baseUrl/notifications/sse',
    header: {
      "Authorization": 'Bearer $token',
      "Accept": "text/event-stream",
    },
    method: SSERequestType.GET,
  );
}
```

The `OrderController` listens to this stream and refreshes orders when events arrive.

---

## Cross-Project Context

### Shared Concepts

**User Roles** (defined in Prisma schema):
- `CLIENT` - Regular customers using mobile app
- `RESTAURATEUR` - Restaurant owners using admin dashboard
- `LIVREUR` - Delivery drivers (future feature)
- `ADMIN` - Platform administrators

**Order Lifecycle**:
1. Client adds products to cart (mobile app)
2. Client proceeds to checkout, creates order
3. Restaurant owner receives notification (admin dashboard)
4. Owner updates status through admin dashboard
5. Client receives notifications about status changes (mobile app)
6. Order reaches LIVRER status

**Menu Lifecycle** (Daily/Special Menus):
1. Restaurant owner creates a daily menu with start/end dates
2. Two types supported:
   - **COMBO**: Menu includes multiple existing products from the catalog
   - **PLAT_SPECIAL**: A temporary unique dish (e.g., "Riz compose") - backend auto-creates a phantom Product + Standard variant so cart/order systems work unchanged. The `ingredients` field stores the free-text composition.
3. When menu is created, push notifications are sent to all previous customers of that restaurant
4. Clients receive notification: "Nouveau menu chez [Restaurant] - [Menu Name] a [Price] FCFA"
5. Menu is automatically visible during its validity period (dateDebut to dateFin)
6. Menu can be manually activated/deactivated by restaurant owner
7. Expired menus are automatically filtered out from active queries
8. When a PLAT_SPECIAL menu is deleted, the phantom product is also cleaned up (unless referenced by past orders)

**Real-time Communication**:
- **Mobile App**: Uses FCM for push notifications
- **Admin Dashboard**: Uses FCM for push notifications + SSE for real-time order updates
- **Backend**: EventEmitter broadcasts events, listeners send notifications

### API Base URL
All frontends connect to: `https://lilia-backend.onrender.com`

### Authentication Pattern
1. User signs in via Firebase (client-side)
2. Backend verifies Firebase ID token on each request
3. Backend uses `firebaseUid` to link Firebase user to database User
4. Role-based access control enforced on backend

### Code Generation Reminder
Both Flutter apps require running `build_runner` after:
- Adding/modifying `@riverpod` annotated providers
- Adding/modifying routes in router
- Changing any Riverpod-generated code

**Command**: `dart run build_runner build --delete-conflicting-outputs`

---

## Working Across Projects

### Typical Workflows

#### Adding a New Feature Involving All Three Projects

1. **Backend First**:
   - Add Prisma model changes to `schema.prisma`
   - Run `npx prisma migrate dev --name feature_name`
   - Create module: `nest g module feature`
   - Create controller, service, DTOs
   - Add endpoints with proper guards and validation
   - Update Swagger documentation

2. **Mobile App**:
   - Create feature folder structure
   - Add models matching backend DTOs
   - Create repository for API calls
   - Create Riverpod controller with `@riverpod`
   - Run `build_runner` to generate providers
   - Build UI screens and widgets
   - Update router if needed

3. **Admin Dashboard** (if relevant):
   - Similar steps as mobile app
   - Focus on admin-specific views (tables, forms)

#### Modifying Order Status
1. Update `OrderStatus` enum in Prisma schema (backend)
2. Run migration
3. Update `OrderStatus` enum in both Flutter apps (models/order.dart)
4. Update UI dropdowns in admin dashboard
5. Update status display in mobile app

#### Adding New Notification Type
1. Backend: Add event emitter call in relevant service
2. Backend: Add FCM notification logic in notifications module
3. Mobile app: Handle notification in `NotificationService`
4. Mobile app: Add UI handler for notification action
5. Admin dashboard: Update SSE listener if relevant

#### Creating Daily Menus
1. Backend: Menu model exists with many-to-many relationship to products + MenuType enum (COMBO/PLAT_SPECIAL)
2. Backend: MenusService handles CRUD operations with date validations
3. Backend: For PLAT_SPECIAL, MenusService auto-creates a phantom Product + Standard variant in a transaction
4. Backend: MenusListener automatically sends FCM notifications to previous customers
5. Mobile app: Display active menus with type-specific UI (composition for PLAT_SPECIAL, product list for COMBO)
6. Admin dashboard: Full menu management UI with type selector (SegmentedButton)

**Menu Creation Example (COMBO)**:
```json
POST /menus
{
  "nom": "Menu du Jour - Mercredi",
  "description": "Notre menu special",
  "prix": 5000,
  "type": "COMBO",
  "dateDebut": "2026-01-15T08:00:00Z",
  "dateFin": "2026-01-15T20:00:00Z",
  "isActive": true,
  "products": [
    { "productId": "clxxx123", "ordre": 1 },
    { "productId": "clxxx456", "ordre": 2 }
  ]
}
```

**Menu Creation Example (PLAT_SPECIAL)**:
```json
POST /menus
{
  "nom": "Riz compose poulet-legumes",
  "description": "Plat special du jour",
  "prix": 3500,
  "type": "PLAT_SPECIAL",
  "ingredients": "Riz, poulet grille, legumes sautes, sauce tomate",
  "dateDebut": "2026-02-27T08:00:00Z",
  "dateFin": "2026-02-27T20:00:00Z",
  "isActive": true
}
```

**PLAT_SPECIAL Technical Details**:
- Backend auto-creates a Product (nom, description, imageUrl, prixOriginal from menu) + ProductVariant (label: "Standard", prix from menu)
- The phantom product is linked to the menu via MenuProduct (ordre: 0)
- On update: phantom product and variant are also updated (nom, prix, description, imageUrl)
- On delete: phantom product + variants are deleted (with fallback if referenced by orders)
- Cart/order systems work unchanged since PLAT_SPECIAL always has a valid productId/variantId

**Notification Flow**:
- Event `menu.created` is emitted by MenusService
- MenusListener queries all clients who previously ordered from this restaurant
- Push notifications sent via Firebase Cloud Messaging
- Notification includes: menu name, price, restaurant name

---

## Current Development Focus

### ✅ Recemment Complete (Fevrier 2026)

**Horaires d'ouverture + Cron auto-update isOpen**:
- ✅ Backend: Enum `DayOfWeek` (LUNDI-DIMANCHE) et modele `OperatingHours` dans Prisma
- ✅ Backend: Champ `manualOverride` sur Restaurant pour priorite du toggle manuel
- ✅ Backend: 3 endpoints API (GET/PUT/PATCH) pour gerer les horaires
- ✅ Backend: Cron job (`@nestjs/schedule`) chaque minute qui ouvre/ferme automatiquement les restaurants
- ✅ Backend: Gestion des horaires passant minuit (ex: 20:00 -> 02:00)
- ✅ Backend: Timezone UTC+1 (Afrique Centrale/Ouest, pas de DST)
- ✅ Backend: Migration `20260212222828_add_operating_hours` appliquee

**Fichiers crees**:
- `src/restaurants/dto/operating-hours.dto.ts` - DTOs avec validation HH:mm
- `src/schedule/restaurant-schedule.service.ts` - Cron job (chaque minute)
- `src/schedule/schedule.module.ts` - Module wrappant ScheduleModule.forRoot()

**Fichiers modifies**:
- `prisma/schema.prisma` - Enum DayOfWeek, modele OperatingHours, champs manualOverride + operatingHours sur Restaurant
- `src/restaurants/restaurants.service.ts` - +3 methodes (setOperatingHours, getOperatingHours, updateOperatingHour), updateOpenStatus set manualOverride:true, findRestaurant/findOne/findRestaurantOwner incluent operatingHours
- `src/restaurants/restaurants.controller.ts` - +3 endpoints horaires, import Put
- `src/app.module.ts` - Import AppScheduleModule

**Logique du cron**:
- Tourne chaque minute
- Ignore les restaurants avec `manualOverride: true`
- Ignore les restaurants sans horaires definis
- Ne met a jour `isOpen` que si le statut doit changer (evite les writes inutiles)
- Gere les horaires traversant minuit (ex: 20:00 -> 02:00)

**Exemple d'utilisation PUT /restaurants/:id/operating-hours**:
```json
{
  "hours": [
    { "dayOfWeek": "LUNDI", "openTime": "08:00", "closeTime": "22:00" },
    { "dayOfWeek": "MARDI", "openTime": "08:00", "closeTime": "22:00" },
    { "dayOfWeek": "MERCREDI", "openTime": "08:00", "closeTime": "22:00" },
    { "dayOfWeek": "JEUDI", "openTime": "08:00", "closeTime": "22:00" },
    { "dayOfWeek": "VENDREDI", "openTime": "08:00", "closeTime": "23:00" },
    { "dayOfWeek": "SAMEDI", "openTime": "10:00", "closeTime": "23:00" },
    { "dayOfWeek": "DIMANCHE", "isClosed": true, "openTime": "00:00", "closeTime": "00:00" }
  ]
}
```

### ✅ Complete (Février 2026) - Logging & Données Client dans Commandes

**Logging structuré du flux de commandes**:
- ✅ Backend: Ajout de logs détaillés dans `orders.service.ts` pour chaque étape de `createOrderFromCart` (validation adresse, panier, restaurant ouvert, stock, calcul montants)
- ✅ Backend: Remplacement de tous les `console.log` par `this.logger` dans `updateOrderStatusByRestaurateur`
- ✅ Backend: Ajout de logs détaillés dans `payment.service.ts` (createPayment, checkPaymentStatus, handlePaymentTimeout)
- ✅ Backend: Chaque log est préfixé par catégorie (📦 [COMMANDE], 🔄 [STATUT], 💰 [PAIEMENT]) pour faciliter le filtrage

**Données client incluses dans l'API commandes restaurant**:
- ✅ Prisma: Ajout relation `user User @relation(...)` dans le modèle `Order` et `orders Order[]` dans le modèle `User`
- ✅ Prisma: Ajout `@@index([userId])` sur Order pour les performances
- ✅ Backend: `findRestaurantOrders` inclut maintenant `user: { select: { id, nom, phone, email, imageUrl } }` dans les deux cas (ADMIN et RESTAURATEUR)
- ⚠️ **Migration requise**: `npx prisma migrate dev --name add_user_order_relation` puis `npx prisma generate`

**Fichiers modifiés**:
- `prisma/schema.prisma` - Relations User↔Order ajoutées + index userId
- `src/orders/orders.service.ts` - Logging structuré + include user dans findRestaurantOrders
- `src/payments/services/payment.service.ts` - Logging structuré complet

### ✅ Complete (Janvier 2026)

**Daily Menu System with Push Notifications**:
- ✅ Backend: Complete CRUD API for daily/special menus (`/menus` endpoints)
- ✅ Backend: Event-driven notification system for new menu creation
- ✅ Backend: Prisma schema updated with MenuDuJour and MenuProduct models
- ✅ Backend: MenusListener sends FCM notifications to previous customers
- 🔄 Mobile App: Display active menus (in progress)
- 🔄 Admin Dashboard: Menu management UI (in progress)

**Key Files**:
- Backend: `src/menus/menus.service.ts` - CRUD operations
- Backend: `src/menus/menus.controller.ts` - 8 REST endpoints
- Backend: `src/listeners/menus.listener.ts` - Notification handling
- Backend: `src/events/menu-events.ts` - Event definitions

### Order Management (Already Implemented)

The admin dashboard has full order management capabilities:
`C:\Users\fatak\Desktop\dreesiscode\code\lilia_admin`

Key files:
- `lib/features/home/data/order_service.dart` - API client + SSE
- `lib/features/home/data/order_controller.dart` - State management
- `lib/features/home/presentation/screens/restaurant_orders_screen.dart` - UI

Backend endpoints:
- `GET /orders/restaurants` - Fetch orders
- `PATCH /orders/:id/status` - Update status
- `GET /notifications/sse` - Real-time updates

### Next Steps

**Planned Features**:
1. ⭐ Favorites system (restaurants and products)
2. 🔄 Re-order functionality (quick repeat orders)
3. 🔍 Search functionality (restaurants, products, categories)
4. 🏷️ Visual badges (popular, fast delivery, new)
5. 🎁 Promo codes system
6. 💯 Loyalty points program
7. ⭐ Reviews and ratings
8. 📊 Personalized recommendations

---

## Common Issues & Solutions

### Backend
- **Prisma Client Out of Sync**: Run `npx prisma generate` after schema changes
- **Migration Fails**: Check database connection and rollback if needed
- **Firebase Token Invalid**: Ensure Firebase Admin SDK is properly configured with service account

### Flutter Apps
- **Provider Not Found**: Run `dart run build_runner build --delete-conflicting-outputs`
- **Firebase Not Initialized**: Ensure `Firebase.initializeApp()` is called before `runApp()`
- **Route Not Found**: Check that route names match between navigation calls and router definition
- **SSE Connection Fails** (admin): Verify Authorization token is valid and not expired

### Cross-Platform
- **401 Unauthorized**: Check Firebase token is being sent correctly in headers
- **CORS Issues**: Backend should have CORS enabled for web debugging
- **Real-time Updates Not Working**:
  - Mobile: Check FCM token is registered with backend
  - Admin: Check SSE connection is active and not timing out

---

## Future Enhancements

### High Priority (User Engagement)
- ⭐ **Favorites System**: Mark restaurants and products as favorites
- 🔄 **Re-order Feature**: Quick repeat of previous orders
- 🔍 **Search & Filters**: Search restaurants/products, filter by price/distance/rating
- 🏷️ **Visual Badges**: Popular, fast delivery, new restaurant indicators
- 🎁 **Promo Codes**: Restaurant-specific promotional codes
- 💯 **Loyalty Program**: Points-based rewards system
- ⭐ **Reviews & Ratings**: Rate restaurants and products, view average ratings

### Medium Priority (Business Tools)
- 📊 **Analytics Dashboard**: Sales reports for restaurant owners
- 📅 **Scheduled Orders**: Order for a specific date/time
- 👥 **Group Orders**: Multiple people ordering together, split delivery fees
- 💬 **In-app Chat**: Simple messaging between clients and restaurants
- 📧 **Email Notifications**: Order confirmations and updates via email

### Long Term (Platform Growth)
- 🚚 **Delivery Driver App**: Complete app for LIVREUR role
- 🏪 **Multi-restaurant Orders**: Order from multiple restaurants in one transaction
- 🌍 **Geolocation**: Distance-based search and delivery fee calculation
- 📱 **Social Features**: Share restaurants, referral program with bonuses
- 🤖 **AI Recommendations**: Personalized product suggestions based on order history
