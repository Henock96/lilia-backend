/**
 * Sprint A — LIL-111
 * Vérifie qu'après la migration `add_vendor_types_and_profiles` :
 *  - tous les restaurants existants ont vendorType = RESTAURANT
 *  - tous les produits existants ont productType = FOOD et stockMode = DAILY
 *  - aucune commande n'est marquée précommande par erreur
 *
 * Usage : npx ts-node scripts/verify-vendor-migration.ts
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL as string,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const errors: string[] = [];

  const totalRestaurants = await prisma.restaurant.count();
  const restaurantsByType = await prisma.restaurant.groupBy({
    by: ['vendorType'],
    _count: { id: true },
  });
  const restaurantOk = restaurantsByType.find((g) => g.vendorType === 'RESTAURANT')?._count.id ?? 0;
  console.log(`Restaurants : ${restaurantOk}/${totalRestaurants} avec vendorType=RESTAURANT`);
  restaurantsByType
    .filter((g) => g.vendorType !== 'RESTAURANT')
    .forEach((g) => console.log(`  - ${g.vendorType} : ${g._count.id}`));
  if (restaurantOk !== totalRestaurants) {
    errors.push(`${totalRestaurants - restaurantOk} restaurants ont un vendorType différent de RESTAURANT`);
  }

  const restaurantsNotApproved = await prisma.restaurant.count({ where: { adminApproved: false } });
  console.log(`Restaurants non approuvés (attendu 0 post-migration) : ${restaurantsNotApproved}`);
  if (restaurantsNotApproved > 0) {
    errors.push(`${restaurantsNotApproved} restaurants ont adminApproved=false (devrait être true par défaut sur l'existant)`);
  }

  const totalProducts = await prisma.product.count();
  const productsFood = await prisma.product.count({ where: { productType: 'FOOD' } });
  const productsDaily = await prisma.product.count({ where: { stockMode: 'DAILY' } });
  console.log(`Produits FOOD : ${productsFood}/${totalProducts}`);
  console.log(`Produits stockMode=DAILY : ${productsDaily}/${totalProducts}`);
  if (productsFood !== totalProducts) {
    errors.push(`${totalProducts - productsFood} produits n'ont pas productType=FOOD`);
  }
  if (productsDaily !== totalProducts) {
    errors.push(`${totalProducts - productsDaily} produits n'ont pas stockMode=DAILY`);
  }

  const preorders = await prisma.order.count({ where: { isPreorder: true } });
  const ageVerifiedOrders = await prisma.order.count({ where: { ageVerified: true } });
  console.log(`Précommandes (attendu 0) : ${preorders}`);
  console.log(`Commandes ageVerified=true (attendu 0) : ${ageVerifiedOrders}`);
  if (preorders > 0) errors.push(`${preorders} commandes isPreorder=true par erreur`);
  if (ageVerifiedOrders > 0) errors.push(`${ageVerifiedOrders} commandes ageVerified=true par erreur`);

  const vendorProfiles = await prisma.vendorProfile.count();
  console.log(`VendorProfile créés : ${vendorProfiles} (attendu 0 post-migration)`);

  if (errors.length > 0) {
    console.error('\n✗ Vérification échouée :');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log('\n✓ Migration Sprint A vérifiée avec succès');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
