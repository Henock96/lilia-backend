/**
 * Délivrabilité FCM par token — les push partent-ils vraiment vers les
 * comptes ADMIN / RESTAURATEUR / LIVREUR ?
 *
 * Envoi en **dryRun** : Firebase valide le couple (credential, token) et
 * renvoie le code d'erreur exact sans rien livrer sur les appareils.
 *
 * Lancer depuis lilia-backend/ :
 *   node --env-file=.env scripts/fcm-deliverability.js
 */
const admin = require('firebase-admin');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function credential() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }
  return admin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
}

async function main() {
  admin.initializeApp({ credential: credential() });
  console.log('Projet Firebase :', process.env.FIREBASE_PROJECT_ID ?? '(service account)');

  const tokens = await prisma.fcmToken.findMany({
    where: { user: { role: { in: ['ADMIN', 'RESTAURATEUR', 'LIVREUR'] } } },
    select: { token: true, createdAt: true, user: { select: { role: true, email: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n${tokens.length} token(s) à tester (dryRun, aucune livraison réelle)\n`);

  const bilan = { ok: 0, ko: 0 };
  for (const t of tokens) {
    const qui = `${t.user.role.padEnd(13)} ${(t.user.email ?? '—').padEnd(20)} ${t.createdAt.toISOString().slice(0, 10)}`;
    try {
      await admin
        .messaging()
        .send({ token: t.token, notification: { title: 'Diag', body: 'Diag' } }, true);
      bilan.ok += 1;
      console.log(`✅ ${qui}  livrable`);
    } catch (e) {
      bilan.ko += 1;
      console.log(`❌ ${qui}  ${e.code}`);
    }
  }

  console.log(`\n── Bilan ── ${bilan.ok} livrable(s) / ${bilan.ko} en échec`);
  console.log('   registration-token-not-registered → app désinstallée ou token périmé');
  console.log('   mismatched-credential             → token émis par un autre projet Firebase');
  console.log('   third-party-auth-error            → APNs (clé iOS refusée par Apple)');
}

main()
  .catch((e) => {
    console.error('❌', e.code ?? '', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
