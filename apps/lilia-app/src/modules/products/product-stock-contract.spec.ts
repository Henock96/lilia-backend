import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';

import { CreateProductDto, MAX_STOCK_UNITS } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateProductStockDto } from './dto/update-product-stock.dto';

/**
 * Le stock doit **survivre au ValidationPipe**.
 *
 * ### Ce que ce test aurait attrapé
 *
 * `stockQuotidien` était absent de `UpdateProductDto`. Le pipe global tourne en
 * `whitelist: true` / `forbidNonWhitelisted: false` : il **supprime en silence**
 * toute propriété non déclarée. Les deux formulaires produit — admin web et
 * admin Flutter — envoyaient donc le champ à `PATCH /products/:id`, recevaient
 * un `200` et un toast « Produit mis à jour », et la base ne bougeait pas d'un
 * pouce. Un vendeur en rupture ne pouvait plus jamais remettre son produit en
 * vente ; pour un `stockMode = PERMANENT`, que le cron de 5 h ne touche pas,
 * c'était définitif.
 *
 * Aucun test de service ne pouvait le voir : le service ne recevait tout
 * simplement pas le champ, et tous ses tests le lui passaient à la main. C'est
 * la **frontière HTTP** qui perdait la donnée, donc c'est elle qu'il faut
 * exercer — d'où le vrai `ValidationPipe`, configuré comme dans `main.ts`, et
 * non un simple `validateSync`.
 */
describe('Contrat de stock — le champ traverse le ValidationPipe', () => {
  // Réplique exacte de la configuration de `main.ts`. Si elle y change, ce test
  // doit changer avec elle : c'est le seul endroit qui documente la dépendance.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const metadata = (metatype: new () => object) =>
    ({ type: 'body', metatype }) as const;

  /**
   * Le reste du corps, minimal mais **valide** : `CreateProductDto` exige un
   * nom et un prix. Sans eux, chaque cas échouerait pour une raison étrangère
   * au stock et le test ne prouverait rien.
   */
  const DTOS_PORTANT_LE_STOCK: Record<
    string,
    { Dto: new () => object; base: Record<string, unknown> }
  > = {
    CreateProductDto: {
      Dto: CreateProductDto,
      base: { nom: 'Poulet braisé', prixOriginal: 3500 },
    },
    UpdateProductDto: { Dto: UpdateProductDto, base: {} },
    UpdateProductStockDto: { Dto: UpdateProductStockDto, base: {} },
  };

  for (const [name, { Dto, base }] of Object.entries(DTOS_PORTANT_LE_STOCK)) {
    describe(name, () => {
      it('conserve stockQuotidien au lieu de le supprimer', async () => {
        const out = (await pipe.transform(
          { ...base, stockQuotidien: 30 },
          metadata(Dto),
        )) as { stockQuotidien?: number | null };

        // `toBe(30)` et non `toBeDefined()` : la suppression par whitelist rend
        // `undefined`, ce qu'un `toBeDefined()` attraperait — mais une future
        // transformation fautive pourrait rendre `NaN` ou `"30"`.
        expect(out.stockQuotidien).toBe(30);
      });

      it('conserve null — c’est « stock illimité », pas « champ absent »', async () => {
        const out = (await pipe.transform(
          { ...base, stockQuotidien: null },
          metadata(Dto),
        )) as { stockQuotidien?: number | null };

        expect(out.stockQuotidien).toBeNull();
      });

      it('refuse un stock négatif', async () => {
        await expect(
          pipe.transform({ ...base, stockQuotidien: -1 }, metadata(Dto)),
        ).rejects.toThrow();
      });

      it('refuse un stock hors bornes', async () => {
        await expect(
          pipe.transform(
            { ...base, stockQuotidien: MAX_STOCK_UNITS + 1 },
            metadata(Dto),
          ),
        ).rejects.toThrow();
      });

      it('refuse un stock non entier', async () => {
        await expect(
          pipe.transform({ ...base, stockQuotidien: 1.5 }, metadata(Dto)),
        ).rejects.toThrow();
      });
    });
  }
});
