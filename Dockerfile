# syntax = docker/dockerfile:1

# --- Étape 1: BUILDER ---
# Cette étape installe TOUTES les dépendances et compile le code.
FROM node:20-slim as builder
WORKDIR /app

# Copier les fichiers de manifest et le schéma Prisma
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Installer TOUTES les dépendances (dev et prod).
# On ne met PAS NODE_ENV=production ici, pour que @nestjs/cli soit bien installé.
RUN npm ci

# Copier le reste du code source
COPY . .

# Compiler l'application. Maintenant, `nest build` fonctionnera.
# Le script `postinstall` ("npx prisma generate") a déjà été lancé par `npm ci`.
RUN npm run build


# --- Étape 2: Image Finale de Production ---
# On repart d'une image propre pour une taille minimale
FROM node:20-slim as final
# C'est SEULEMENT ICI qu'on définit l'environnement de production
ENV NODE_ENV=production
WORKDIR /app

# Installer OpenSSL, requis par Prisma pour se connecter à la base de données
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# Copier les fichiers de manifest et le schéma
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Installer UNIQUEMENT les dépendances de production.
# Comme NODE_ENV=production, `npm ci` va ignorer les devDependencies.
RUN npm ci --omit=dev

# Copier le code compilé depuis l'étape builder
COPY --from=builder /app/dist ./dist

# Exposer le port
EXPOSE 3000

# Commande de démarrage pour la production
# La commande `release_command` dans fly.toml s'occupera des migrations
CMD [ "node", "dist/main.js" ]
 