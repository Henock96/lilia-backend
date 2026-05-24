/**
 * Diagnostic FCM — vérifie qu'un service account Firebase peut bien
 * envoyer une notification push. Usage ponctuel (pas besoin de committer).
 *
 * Lancer depuis lilia-backend/ (firebase-admin doit être installé) :
 *   node scripts/fcm-diag.js <chemin/vers/service-account.json> <token-fcm-device>
 *
 * Récupérer un token de device RÉEL (sinon le mismatch de projet
 * ne peut pas être détecté) — depuis la base :
 *   SELECT token FROM "FcmToken" ORDER BY "createdAt" DESC LIMIT 1;
 */
const admin = require('firebase-admin');
const path = require('path');

const saPath = process.argv[2];
const token = process.argv[3];

if (!saPath) {
  console.error('Usage: node scripts/fcm-diag.js <service-account.json> <token-fcm>');
  process.exit(1);
}

const sa = require(path.resolve(saPath));
console.log('── Service account ─────────────────────────────');
console.log('  project_id   :', sa.project_id);
console.log('  client_email :', sa.client_email);
console.log('  → les deux DOIVENT être sur le projet  lilia-app-d8f6f');
console.log('────────────────────────────────────────────────');

admin.initializeApp({ credential: admin.credential.cert(sa) });

if (!token) {
  console.log('⚠️  Aucun token FCM fourni — passe un token de device réel en 2e');
  console.log('   argument pour le test d\'envoi complet (détecte le mismatch projet).');
  process.exit(0);
}

admin
  .messaging()
  .send({ token, notification: { title: 'Diag FCM', body: 'Test' } }, true) // dryRun = true → valide sans livrer
  .then((id) => {
    console.log('✅ SUCCÈS — ce service account peut envoyer à ce device.');
    console.log('   messageId:', id);
    console.log('   Si la prod échoue encore → variables mal recopiées sur Render.');
  })
  .catch((e) => {
    console.error('❌ ÉCHEC FCM');
    console.error('   code    :', e.code);
    console.error('   message :', e.message);
    console.error('');
    console.error('   messaging/mismatched-credential   → service account et token sur 2 projets différents');
    console.error('   messaging/authentication-error    → clé privée / service account invalide');
    console.error('   registration-token-not-registered → token de test périmé, en reprendre un récent');
  });
