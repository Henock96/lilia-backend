/**
 * Charge l'environnement avec **la même cascade que l'application**.
 *
 * `require('dotenv').config()` ne lit que `.env` — c'est-à-dire, dans ce dépôt,
 * les identifiants de production. Les scripts d'administration visaient donc la
 * production alors que `npm run start:dev` visait le local : deux vérités pour
 * une même question, et c'est celle qu'on ne regarde pas qui fait les dégâts.
 *
 * Ordre — **la première occurrence d'une clé gagne**, comme `ConfigModule` :
 *   1. `.env.local`            surcharges du poste, non versionné
 *   2. `.env.<NODE_ENV>`       base et Redis locaux, versionné, sans secret
 *   3. `.env`                  secrets, non versionné
 */
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const files = [
    '.env.local',
    `.env.${process.env.NODE_ENV || 'development'}`,
    '.env',
  ];
  for (const file of files) {
    // `override: false` : ce qui est déjà posé (par le shell ou par un fichier
    // précédent) n'est jamais réécrit. C'est ce qui donne la priorité au
    // premier fichier de la liste, et à la ligne de commande avant tous.
    dotenv.config({ path: path.join(ROOT, file), override: false, quiet: true });
  }
}

module.exports = { loadEnv };
