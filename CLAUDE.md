# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview: Lilia Food

Lilia Food is a complete food delivery platform consisting of three main components:
1. **Backend API** (NestJS Monorepo + Prisma + PostgreSQL + Firebase Admin SDK)
2. **Client Mobile App** (Flutter + Riverpod)
3. **Admin Dashboard** (Flutter + Riverpod)

All components communicate through a RESTful API with Firebase Authentication providing identity management.

---

## Backend - NestJS API (Monorepo)

**Location**: `C:\Users\fatak\lilia-app`

### Development Commands

```bash
# Install dependencies
npm install

# Development mode with hot reload (main API)
npm run start:dev

# Build all apps (monorepo)
npm run build

# Build specific app
npx nest build worker

# Run production build
npm run start:prod    # → node dist/apps/lilia-app/main

# Run tests
npm run test
npm run test:watch
npm run test:e2e

# Lint and format
npm run lint          # Lints apps/ and libs/
npm run format        # Prettier on apps/ and libs/

# Prisma commands
npx prisma generate              # Generate Prisma client
npx prisma migrate dev           # Create and apply migration
npx prisma migrate deploy        # Apply migrations in production
npx prisma studio                # Open Prisma Studio GUI

# Full deployment build (for Render)
npm run render-build
```

### Architecture

#### Monorepo Structure

The backend uses NestJS monorepo mode with 2 applications:

```
C:\Users\fatak\lilia-app/
├── apps/
│   ├── lilia-app/           # Main REST API application
│   │   ├── src/
│   │   │   ├── main.ts           # Bootstrap + Firebase init + Swagger
│   │   │   ├── app.module.ts     # Root module (wires all modules)
│   │   │   ├── app.controller.ts
│   │   │   ├── app.service.ts
│   │   │   ├── prisma/           # Prisma ORM service (global)
│   │   │   ├── common/           # Shared utils (pagination, interceptors, filters)
│   │   │   └── modules/          # All domain & infra modules (20+)
│   │   ├── tsconfig.app.json
│   │   └── test/
│   └── worker/              # Background job processor (skeleton)
│       ├── src/
│       │   ├── main.ts
│       │   ├── worker.module.ts
│       │   ├── worker.controller.ts
│       │   └── worker.service.ts
│       └── tsconfig.app.json
├── prisma/
│   ├── schema.prisma             # Shared database schema
│   └── migrations/
├── nest-cli.json                 # Monorepo config (projects: lilia-app, worker)
├── tsconfig.json                 # Root TS config (ES2021, CommonJS)
├── tsconfig.build.json
├── tsconfig.eslint.json
├── package.json
└── .eslintrc.js
```

**Build output**: `dist/apps/lilia-app/` and `dist/apps/worker/`

#### Tech Stack
- **Framework**: NestJS 11.x (monorepo mode with webpack)
- **Database**: PostgreSQL via Prisma ORM 6.x
- **Authentication**: Firebase Admin SDK for token verification (global guards)
- **File Storage**: Cloudinary for image uploads
- **SMS**: Africa's Talking integration
- **Email**: Mailtrap integration
- **Payments**: MTN Mobile Money (sandbox + manual + production modes)
- **Real-time**: EventEmitter2 for order/payment/menu events
- **Push Notifications**: Firebase Cloud Messaging (FCM)
- **Cron Jobs**: @nestjs/schedule (auto-open/close restaurants, daily stock reset)
- **API Documentation**: Swagger/OpenAPI v11

#### Module Structure

All modules are under `apps/lilia-app/src/modules/`:

```
apps/lilia-app/src/
├── main.ts
├── app.module.ts
├── prisma/                    # Prisma service (global singleton)
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── common/                    # Shared infrastructure
│   ├── common.module.ts
│   ├── exception-filters/http-exception.filter.ts
│   ├── interceptors/api-response-interceptor.ts
│   ├── pagination/pagination.service.ts
│   └── types/APIResponse.ts
└── modules/
    ├── auth/                  # Authentication & authorization (global guards)
    │   ├── auth.module.ts          # Registers FirebaseAuthGuard + RolesGuard as APP_GUARD
    │   ├── guards/
    │   │   ├── firebase-auth.guard.ts   # Verifies Firebase ID tokens
    │   │   └── roles.guard.ts           # Role-based access control
    │   ├── decorators/
    │   │   ├── public.decorator.ts      # @Public() - bypass auth
    │   │   ├── roles.decorator.ts       # @Roles('ADMIN', 'RESTAURATEUR')
    │   │   ├── firebase-user.decorator.ts  # @FirebaseUser() → DecodedIdToken
    │   │   └── current-user.decorator.ts   # @CurrentUser() → Prisma User
    │   └── types/authenticated-request.interface.ts
    ├── firebase/              # Firebase Admin SDK wrapper
    ├── users/                 # User management (sync with Firebase)
    ├── restaurants/           # Restaurant CRUD + operating hours
    ├── products/              # Product catalog management
    ├── categories/            # Product categories
    ├── menus/                 # Daily menu management (COMBO + PLAT_SPECIAL)
    ├── cart/                  # Shopping cart operations
    ├── orders/                # Order management (state machine + validators + stock)
    │   ├── orders.module.ts
    │   ├── orders.controller.ts
    │   ├── orders.service.ts
    │   ├── order-state.machine.ts      # Finite state machine for status transitions
    │   ├── order-validator.service.ts  # Pre-order validation (address, stock, restaurant open)
    │   ├── order-calculator.service.ts # Price calc (subTotal, deliveryFee, serviceFee 10%)
    │   ├── stock.service.ts            # Atomic stock decrement via raw SQL
    │   └── dto/
    ├── deliveries/            # Delivery assignment and tracking
    ├── payments/              # MTN MoMo payment processing
    │   ├── payment.module.ts
    │   ├── controllers/
    │   │   ├── payment.controller.ts   # Payment initiation + confirmation
    │   │   └── webhook.controller.ts   # MTN MoMo webhook receiver
    │   ├── services/
    │   │   ├── payment.service.ts      # Payment logic (MANUAL/SANDBOX/MTN_PRODUCTION)
    │   │   └── mtn-momo.service.ts     # MTN MoMo API client
    │   └── types/mtn-momo.types.ts
    ├── reviews/               # Customer ratings & reviews
    ├── dashboard/             # Analytics (revenue, top products, peak hours, clients)
    ├── admin/                 # Platform admin (user management, restaurant creation)
    ├── banners/               # Promotional banners with display order
    ├── notifications/         # FCM push notifications + SSE
    ├── email/                 # Email service via Mailtrap
    ├── sms/                   # SMS via Africa's Talking
    ├── cloudinary/            # Image upload service
    ├── adresses/              # User addresses
    ├── quartiers/             # Delivery zones
    ├── schedule/              # Cron jobs (auto isOpen + daily stock reset)
    ├── health/                # Health check endpoint
    ├── events/                # Event definitions (order, menu, user events)
    └── listeners/             # Event handlers (orders, payments, menus, user)
```

#### Global Guards Architecture

Authentication is centralized in `AuthModule` via `APP_GUARD`:
1. **FirebaseAuthGuard** (global) - Verifies `Authorization: Bearer <token>`, populates `request.firebaseUser`
2. **RolesGuard** (global) - If `@Roles()` present, checks role and populates `request.user` (Prisma User)

Routes are protected by default. Use `@Public()` to exempt. Use `@Roles('RESTAURATEUR', 'ADMIN')` for role restrictions.

Decorators available in controllers:
- `@FirebaseUser()` → `DecodedIdToken` (Firebase uid, email, etc.)
- `@CurrentUser()` → Prisma `User` (id, role, nom, etc.) - available after `@Roles()`
- `@Public()` → bypass authentication entirely
- `@Roles('CLIENT', 'RESTAURATEUR', 'LIVREUR', 'ADMIN')` → role requirement

#### Database Schema Overview (Prisma)

Key models and relationships:
- **User**: Links Firebase UID to app data, has role (ADMIN, RESTAURATEUR, LIVREUR, CLIENT)
- **Restaurant**: Owned by a User with RESTAURATEUR role, has `manualOverride` for cron control
- **Product**: Belongs to Restaurant and Category, has ProductVariants, has `stockQuotidien`/`stockRestant`
- **ProductVariant**: Different sizes/options for products (30cl, 1.5L, etc.)
- **MenuDuJour**: Daily/special menus via `MenuType` enum: `COMBO` | `PLAT_SPECIAL`
- **MenuProduct**: Junction table for MenuDuJour ↔ Product (many-to-many)
- **Cart/CartItem**: One cart per user, items link Product + ProductVariant + optional MenuDuJour
- **Order/OrderItem**: Immutable price snapshots at order time, includes `serviceFee` (10%)
- **Delivery**: One per order, tracks delivery status and deliverer
- **Payment**: MTN MoMo transactions (modes: MANUAL, SANDBOX, MTN_PRODUCTION)
- **Review**: Customer ratings (1-5) with optional comment, unique per user+restaurant (`@@unique([userId, restaurantId])`)
- **DeliveryZone/QuartierZone**: Restaurant-specific delivery pricing per zone
- **Banner**: Promotional banners with `displayOrder` and `isActive`
- **Adresses**: User's saved delivery addresses with `isDefault` flag
- **FcmToken**: FCM tokens for push notifications
- **OperatingHours**: Weekly hours per restaurant (DayOfWeek enum, openTime/closeTime HH:mm)

#### Key Endpoints

**Users** (`/users`):
- `POST /users/sync` - Sync Firebase user to DB (called at each login)
- `GET /users/me` - Get current user profile
- `PUT /users/me` - Update profile

**Orders** (`/orders`):
- `POST /orders/checkout` - Create order from cart
- `GET /orders/my` - Get current user's orders (paginated)
- `GET /orders/restaurant` - Get restaurant's orders (RESTAURATEUR/ADMIN)
- `GET /orders/user/:userId` - Get user's orders (ADMIN)
- `PATCH /orders/:id/status` - Update order status (RESTAURATEUR/ADMIN)
- `PATCH /orders/:id/cancel` - Cancel order (CLIENT, only from EN_ATTENTE)
- `DELETE /orders/:id` - Soft-delete cancelled order (CLIENT)
- `POST /orders/:id/reorder` - Re-order from previous order

**Cart** (`/cart`):
- `GET /cart` - Get current cart
- `POST /cart/add` - Add product to cart
- `POST /cart/add-menu` - Add menu to cart
- `PATCH /cart/items/:id` - Update item quantity
- `PATCH /cart/menus/:menuId` - Update menu quantity
- `DELETE /cart/items/:id` - Remove item
- `DELETE /cart/menus/:menuId` - Remove menu
- `DELETE /cart/clear` - Clear cart

**Restaurants** (`/restaurants`):
- `GET /restaurants` - List all (includes operatingHours)
- `GET /restaurants/:id` - Details with products and hours
- `GET /restaurants/mine` - Owner's restaurant (RESTAURATEUR/ADMIN)
- `PATCH /restaurants/:id` - Update info
- `PATCH /restaurants/:id/open-status` - Toggle open/closed (sets manualOverride)
- `PATCH /restaurants/:id/delivery-settings` - Delivery settings
- `GET /restaurants/:id/operating-hours` - Get hours (public)
- `PUT /restaurants/:id/operating-hours` - Set weekly hours in bulk
- `PATCH /restaurants/:id/operating-hours/:dayOfWeek` - Update single day

**Products** (`/products`):
- `GET /products` - List (with filters)
- `POST /products` - Create (restaurant owner)
- `PATCH /products/:id` - Update
- `DELETE /products/:id` - Delete

**Menus** (`/menus`):
- `POST /menus` - Create menu
- `GET /menus` - List (filters: restaurantId, isActive, includeExpired)
- `GET /menus/active` - Active menus for today
- `GET /menus/restaurant` - Owner's menus
- `GET /menus/:id` - Menu details with products
- `PATCH /menus/:id` - Update
- `PATCH /menus/:id/toggle` - Activate/deactivate
- `DELETE /menus/:id` - Delete

**Reviews** (`/reviews`):
- `POST /reviews` - Create review (must have delivered order)
- `GET /reviews/restaurant/:id` - Restaurant reviews + stats
- `GET /reviews/restaurant/:id/stats` - Rating stats
- `GET /reviews/my/:restaurantId` - User's review for restaurant
- `GET /reviews/can-review/:restaurantId` - Check if can review
- `GET /reviews/:id` - Get review
- `PATCH /reviews/:id` - Update (author only)
- `DELETE /reviews/:id` - Delete (author or admin)

**Dashboard** (`/dashboard`):
- `GET /dashboard/overview` - Global stats (orders, revenue, clients)
- `GET /dashboard/orders` - Orders by status with percentages
- `GET /dashboard/top-products` - Top 10 best-selling products
- `GET /dashboard/revenue` - Daily revenue chart (30 days)
- `GET /dashboard/clients` - Client analytics (new/returning/top)
- `GET /dashboard/peak-hours` - Hourly order distribution
- `GET /dashboard/restaurants` - Restaurant ranking (ADMIN)

**Payments** (`/payments`):
- `POST /payments` - Initiate payment (MANUAL/SANDBOX/MTN)
- `GET /payments/:paymentId/status` - Check payment status
- `POST /payments/:paymentId/confirm` - Manual confirmation (ADMIN)

**Notifications** (`/notifications`):
- `POST /notifications/register-token` - Register FCM token
- `DELETE /notifications/token` - Remove FCM token (logout)

**Admin** (`/admin`):
- Admin-only endpoints for user role management, restaurant creation with owner, user ban/activate

**Banners** (`/banners`):
- CRUD for promotional banners with display order management

#### Order State Machine

Valid status transitions enforced by `OrderStateMachine`:
```
EN_ATTENTE → CONFIRMER → EN_PREPARATION → PRET → LIVRER
EN_ATTENTE → ANNULER (client can cancel)
CONFIRMER → ANNULER (restaurateur/admin)
EN_ATTENTE → PAYER (after payment success)
```

Transition permissions:
- **CLIENT**: can cancel (EN_ATTENTE → ANNULER)
- **RESTAURATEUR**: can confirm, prepare, mark ready, deliver, cancel
- **ADMIN**: all transitions

#### Event-Driven Architecture

**Events** (defined in `modules/events/`):
- `order.created` → Notify restaurant + client
- `order.status.updated` → Notify client of status change
- `order.cancelled` → Notify parties
- `order.payment.confirmed` → Update order to PAYER
- `order.payment.failed` → Handle failed payment
- `menu.created` → Notify previous customers (FCM + email)
- `user.created` → Send welcome email

**Listeners** (in `modules/listeners/`):
- `OrdersListener` - Order creation/status events → FCM notifications
- `PaymentListener` - Payment success → update order + notify
- `MenusListener` - Menu creation → query past customers → send push notifications
- `UserListener` - User registration → send welcome email via Mailtrap

#### Payment Modes

The payment system supports 3 modes via `PAYMENT_MODE` env var:
- **MANUAL** (default): Client pays via MTN MoMo transfer to Lilia number, admin confirms manually
- **SANDBOX**: MTN MoMo sandbox API for testing
- **MTN_PRODUCTION**: Live MTN MoMo API (requires aggregator agreement)

#### Environment Variables Required
```
DATABASE_URL=postgresql://...
PORT=8080

# Firebase
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
FIREBASE_SERVICE_ACCOUNT_PATH=...  # Dev only: path to service account JSON

# Cloudinary
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# SMS (Africa's Talking)
AFRICAS_TALKING_API_KEY=...
AFRICAS_TALKING_USERNAME=...
SMS_SENDER_ID=LiliaFood

# Email (Mailtrap)
MAILTRAP_API_TOKEN=...
MAILTRAP_SENDER_EMAIL=noreply@lilia-food.com
MAILTRAP_SENDER_NAME=Lilia Food

# Payments
PAYMENT_MODE=MANUAL              # MANUAL | SANDBOX | MTN_PRODUCTION
LILIA_PAYMENT_PHONE=...          # Lilia Food MTN MoMo number (MANUAL mode)
MTN_MOMO_API_KEY=...
MTN_MOMO_API_USER=...
```

#### Deployment
The backend is deployed on **Render** with the `render-build` script:
1. `npm install`
2. `npx prisma generate`
3. `npx prisma migrate deploy`
4. `npm run build`

Production start: `node dist/apps/lilia-app/main`

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
2. On successful auth, sync user to backend via `/users/sync`
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
2. Client proceeds to checkout, order validated (address, stock, restaurant open)
3. Order created with immutable price snapshots (subTotal + deliveryFee + serviceFee)
4. Client pays via MTN MoMo (manual or automatic)
5. Restaurant owner receives notification (admin dashboard)
6. Owner updates status through admin dashboard (state machine enforced)
7. Client receives notifications about status changes
8. Order reaches LIVRER status

**Menu Lifecycle** (Daily/Special Menus):
1. Restaurant owner creates a daily menu with start/end dates
2. Two types supported:
   - **COMBO**: Menu includes multiple existing products from the catalog
   - **PLAT_SPECIAL**: A temporary unique dish - backend auto-creates a phantom Product + Standard variant
3. When menu is created, push notifications are sent to all previous customers of that restaurant
4. Menu is automatically visible during its validity period (dateDebut to dateFin)
5. Menu can be manually activated/deactivated by restaurant owner

**Real-time Communication**:
- **Mobile App**: Uses FCM for push notifications
- **Admin Dashboard**: Uses FCM for push notifications + SSE for real-time order updates
- **Backend**: EventEmitter2 broadcasts events, listeners send notifications

### API Base URL
All frontends connect to: `https://lilia-backend.onrender.com`

### Authentication Pattern
1. User signs in via Firebase (client-side)
2. Backend verifies Firebase ID token on each request (global guard)
3. Backend uses `firebaseUid` to link Firebase user to database User
4. Role-based access control enforced globally via `@Roles()` decorator

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
   - Add Prisma model changes to `prisma/schema.prisma`
   - Run `npx prisma migrate dev --name feature_name`
   - Create module under `apps/lilia-app/src/modules/feature/`
   - Create controller, service, DTOs
   - Add to `app.module.ts` imports
   - Use `@Public()` or `@Roles()` for access control
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
1. Update `OrderStatus` enum in Prisma schema
2. Update `OrderStateMachine` transitions in `apps/lilia-app/src/modules/orders/order-state.machine.ts`
3. Run migration
4. Update `OrderStatus` enum in both Flutter apps
5. Update UI dropdowns in admin dashboard

#### Adding New Notification Type
1. Backend: Create event class in `modules/events/`
2. Backend: Emit event in relevant service
3. Backend: Create/update listener in `modules/listeners/`
4. Backend: Add listener to `app.module.ts` providers
5. Mobile app: Handle notification in `NotificationService`
6. Admin dashboard: Update SSE listener if relevant

---

## Current Development Focus

### Completed (April 2026) - Monorepo Refactoring

**Backend refactored to NestJS monorepo architecture**:
- Migrated from flat `src/` to `apps/lilia-app/src/modules/` structure
- Created centralized `AuthModule` with global guards (no more per-controller `@UseGuards()`)
- Added `OrderStateMachine` for enforced status transitions
- Added `OrderValidatorService` for comprehensive pre-order validation
- Added `OrderCalculatorService` for price snapshots (subTotal, deliveryFee, serviceFee 10%)
- Added `StockService` with atomic SQL-level stock decrement (no race conditions)
- Added `DashboardModule` with 8 analytics endpoints
- Added `ReviewsModule` with ratings, stats, and unique constraints
- Added `AdminModule` for platform administration
- Added `BannersModule` for promotional content
- Added `EmailModule` via Mailtrap (welcome emails, menu notifications)
- Added `SmsModule` via Africa's Talking
- Migrated SMS from Twilio to Africa's Talking
- Upgraded `@nestjs/swagger` from v2.5.1 to v11.x
- Upgraded `@nestjs/config` from v1.1.5 to v4.x
- Worker app skeleton created for future background jobs
- Added `@@unique([userId, restaurantId])` on Review model
- Added `@unique` on Review.orderId

### Previously Completed

**Horaires d'ouverture + Cron auto-update isOpen** (Feb 2026):
- Operating hours per day (DayOfWeek enum)
- Cron job every minute auto-opens/closes restaurants
- Manual override support
- Midnight-crossing hours handled
- Timezone UTC+1

**Daily Menu System** (Jan 2026):
- Complete CRUD for COMBO + PLAT_SPECIAL menus
- Event-driven FCM notifications to past customers
- Phantom product creation for PLAT_SPECIAL

**Order Management**:
- Full lifecycle from cart to delivery
- Real-time SSE updates for admin dashboard
- Structured logging throughout

### Next Steps

**Planned Features**:
1. Favorites system (restaurants and products)
2. Search functionality (restaurants, products, categories)
3. Visual badges (popular, fast delivery, new)
4. Promo codes system
5. Loyalty points program
6. Personalized recommendations
7. Delivery driver app (LIVREUR role)
8. Worker app implementation (email queues, scheduled reports)

---

## Common Issues & Solutions

### Backend
- **Prisma Client Out of Sync**: Run `npx prisma generate` after schema changes
- **Migration Fails**: Check `DATABASE_URL` and rollback if needed
- **Firebase Token Invalid**: Ensure Firebase Admin SDK configured (env vars or service account JSON)
- **Import Paths After Moving Files**: Modules in `apps/lilia-app/src/modules/xxx/` use:
  - `../../prisma/prisma.service` for Prisma (goes to `src/prisma/`)
  - `../../common/...` for common utils (goes to `src/common/`)
  - `../events/...` for event definitions (sibling under `modules/`)
  - `../auth/decorators/...` for auth decorators (sibling under `modules/`)
- **Swagger Errors**: Ensure `@nestjs/swagger` v11+ is installed (v2 API is incompatible)

### Flutter Apps
- **Provider Not Found**: Run `dart run build_runner build --delete-conflicting-outputs`
- **Firebase Not Initialized**: Ensure `Firebase.initializeApp()` is called before `runApp()`
- **Route Not Found**: Check that route names match between navigation calls and router definition
- **SSE Connection Fails** (admin): Verify Authorization token is valid and not expired

### Cross-Platform
- **401 Unauthorized**: Check Firebase token is being sent correctly in headers
- **CORS Issues**: Backend has CORS enabled with permissive settings for SSE
- **Real-time Updates Not Working**:
  - Mobile: Check FCM token is registered with backend
  - Admin: Check SSE connection is active and not timing out
