/**
 * Inventaire des tokens FCM par rôle — qui est réellement joignable par push ?
 *
 * Lecture seule. Lancer depuis lilia-backend/ :
 *   node --env-file=.env scripts/fcm-audience.js
 *
 * Prisma 7 exige l'adapter explicite ici (`datasourceUrl` est rejeté).
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const users = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'RESTAURATEUR', 'LIVREUR'] } },
    select: {
      id: true,
      role: true,
      email: true,
      statusUser: true,
      fcmTokens: { select: { token: true, createdAt: true } },
    },
  });

  const parRole = {};
  for (const u of users) {
    const r = (parRole[u.role] ??= { users: 0, avecToken: 0, tokens: 0 });
    r.users += 1;
    if (u.fcmTokens.length) {
      r.avecToken += 1;
      r.tokens += u.fcmTokens.length;
    }
  }

  console.log('── Audience push par rôle ──────────────────────');
  for (const [role, r] of Object.entries(parRole)) {
    console.log(
      `  ${role.padEnd(14)} ${String(r.avecToken).padStart(3)}/${String(r.users).padEnd(3)} users joignables — ${r.tokens} token(s)`,
    );
  }
  console.log('────────────────────────────────────────────────');

  for (const u of users.filter((x) => x.fcmTokens.length)) {
    for (const t of u.fcmTokens) {
      console.log(
        `${u.role.padEnd(13)} ${u.statusUser.padEnd(7)} ${(u.email ?? '—').padEnd(32)} ${t.createdAt.toISOString().slice(0, 10)} ${t.token.slice(0, 24)}…`,
      );
    }
  }

  const muets = users.filter((x) => !x.fcmTokens.length);
  if (muets.length) {
    console.log(`\n⚠️  ${muets.length} compte(s) sans aucun token (push impossible) :`);
    for (const u of muets) console.log(`   ${u.role.padEnd(13)} ${u.email ?? u.id}`);
  }
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
