# syntax = docker/dockerfile:1

# 1. Étape de base : Définir la version de Node
ARG NODE_VERSION=20.15.0
FROM node:${NODE_VERSION}-slim as base
ENV NODE_ENV=production
WORKDIR /app

# 2. Étape des dépendances : Installer uniquement les dépendances
FROM base as deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 3. Étape de build : Compiler le code TypeScript
# On réutilise les dépendances de l'étape précédente pour profiter du cache Docker
FROM base as builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Le `postinstall` dans package.json va lancer `prisma generate`
RUN npm run build

# 4. Étape finale : Créer l'image de production légère
FROM base
# Met à jour les paquets et installe OpenSSL, nécessaire pour Prisma
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Copier uniquement les artefacts nécessaires depuis les étapes précédentes
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Exposer le port (Fly.io le détectera automatiquement mais c'est une bonne pratique)
EXPOSE 3000

# Commande de démarrage pour la production
CMD ["node", "dist/main.js"]