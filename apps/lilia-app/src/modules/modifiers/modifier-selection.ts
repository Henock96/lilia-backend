/**
 * F3-09 — **le** moteur de sélection d'options. Un seul, partagé.
 *
 * C'est le SEUL endroit du système qui transforme « ce produit, cette variante,
 * ces options choisies » en :
 *
 * ```
 * { signature, unitPriceXaf, optionsTotalXaf, lines }
 * ```
 *
 * ou en refus nominatif (`ModifierSelectionError`, avec un `code` stable que
 * les clients traduisent). Le panier (`POST /cart/add`, `GET /cart`), le
 * checkout (avant ET dans la transaction), le recommander et l'aperçu promo
 * l'appellent ; aucun d'eux ne recompte un prix ni ne revalide une cardinalité.
 *
 * Fonctions pures, sans Prisma ni Nest : le chargement du catalogue vit dans
 * `modifier-catalog.ts`, qui en fait des `ModifierProductContext`. Ce fichier
 * se teste donc sans base, et se lit sans connaître le schéma.
 *
 * ## Règles (toutes testées dans `modifier-selection.spec.ts`)
 *
 * - `minSelect` / `maxSelect` comptent des options **distinctes**, pas la
 *   somme des quantités : « Alloco ×2 + Œuf ×1 » = 2 choix.
 * - Une même option citée deux fois dans la requête est **refusée**
 *   (`DUPLICATE_OPTION`) et non fusionnée : `A×1 + A×2` n'est pas `A×3`, c'est
 *   une requête mal formée, et la deviner reviendrait à facturer ce que le
 *   client n'a peut-être pas voulu.
 * - Une option d'un autre produit, d'un autre vendeur ou inconnue :
 *   `MODIFIER_FOREIGN` (on ne distingue pas les trois, pour ne rien révéler du
 *   catalogue d'autrui).
 * - Option supprimée ou en rupture : `MODIFIER_UNAVAILABLE`.
 * - Groupe obligatoire sans choix : `MODIFIER_REQUIRED`. **Jamais** de
 *   sélection automatique — une application ancienne ne reçoit pas un plat
 *   qu'elle n'a pas choisi.
 * - Interrupteur `modifiersEnabled` éteint : les groupes sont ignorés (retour
 *   au comportement d'avant F3-09) et toute option envoyée est refusée
 *   (`MODIFIERS_DISABLED`).
 *
 * ## Signature canonique
 *
 * `optionId:quantité`, triés par identifiant (ordre des points de code),
 * joints par `,`. `""` = aucune option. L'ordre d'entrée ne la change pas ;
 * les identifiants sont bornés (`[A-Za-z0-9_-]{1,40}`) donc ni `:` ni `,` ne
 * peuvent y apparaître — la chaîne est sans ambiguïté et se relit en base.
 * Bornée à 20 options, elle tient sous 1000 caractères (CHECK en base).
 */

/** Plafonds Q8 — exportés pour les DTO, les services et les tests. */
export const MODIFIER_LIMITS = {
  /** Quantité maximale d'une même option sur une unité (CHECK en base). */
  MAX_OPTION_QUANTITY: 10,
  /** Options distinctes sur une ligne (et `maxSelect` maximal d'un groupe). */
  MAX_DISTINCT_OPTIONS_PER_LINE: 20,
  /**
   * Somme des quantités d'options sur une unité. Sans elle, 20 options × 10
   * feraient 200 suppléments sur un seul plat : aucune cuisine ne le prépare,
   * et c'est la même classe de défaut que `quantite: 2 000 000 000` (S10).
   */
  MAX_TOTAL_OPTION_QUANTITY_PER_LINE: 30,
  /** Groupes (non supprimés) dans la bibliothèque d'un vendeur. */
  MAX_GROUPS_PER_VENDOR: 30,
  /** Options (non supprimées) dans un groupe. */
  MAX_OPTIONS_PER_GROUP: 20,
  /** Groupes attachés à un même produit. */
  MAX_GROUPS_PER_PRODUCT: 10,
  /** Longueur maximale d'un identifiant d'option accepté en entrée. */
  OPTION_ID_MAX_LENGTH: 40,
} as const;

export const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export type ModifierErrorCode =
  | 'MODIFIER_REQUIRED'
  | 'MODIFIER_TOO_MANY'
  | 'MODIFIER_UNAVAILABLE'
  | 'MODIFIER_FOREIGN'
  | 'MODIFIER_INVALID_QUANTITY'
  | 'DUPLICATE_OPTION'
  | 'MODIFIERS_DISABLED';

/** Refus métier, nominatif. Le `code` est un contrat avec les clients. */
export class ModifierSelectionError extends Error {
  constructor(
    public readonly code: ModifierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModifierSelectionError';
  }
}

/** Option telle que choisie par le client. */
export interface SelectedOptionInput {
  optionId: string;
  quantity: number;
}

export interface ModifierCatalogOption {
  id: string;
  name: string;
  priceDeltaXaf: number;
  maxQuantity: number;
  isAvailable: boolean;
  deletedAt: Date | null;
  displayOrder: number;
}

export interface ModifierCatalogGroup {
  id: string;
  restaurantId: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  deletedAt: Date | null;
  /** Toutes les options du groupe, supprimées comprises (pour nommer le refus). */
  options: ModifierCatalogOption[];
}

/** Ce qu'il faut savoir d'un produit pour résoudre une sélection. */
export interface ModifierProductContext {
  productName: string;
  restaurantId: string;
  /** Groupes attachés au produit, dans l'ordre d'affichage du vendeur. */
  groups: ModifierCatalogGroup[];
}

/** Une option résolue — ce qui sera figé dans `OrderItemOption`. */
export interface ResolvedOptionLine {
  optionId: string;
  groupId: string;
  groupName: string;
  optionName: string;
  priceDeltaXaf: number;
  quantity: number;
  /** Ordre d'affichage : groupes du produit, puis options du groupe. */
  position: number;
}

export interface ResolvedSelection {
  signature: string;
  /** Σ(priceDeltaXaf × quantity) — la part des options dans le prix unitaire. */
  optionsTotalXaf: number;
  /** Prix de la variante + options : **le** prix unitaire facturé. */
  unitPriceXaf: number;
  lines: ResolvedOptionLine[];
}

/** Sélection vide : ni option, ni supplément. */
export function emptySelection(basePriceXaf: number): ResolvedSelection {
  return {
    signature: '',
    optionsTotalXaf: 0,
    unitPriceXaf: basePriceXaf,
    lines: [],
  };
}

/**
 * Contrôles de forme, indépendants du catalogue : identifiants, quantités,
 * doublons, plafonds. Partagés par `resolveSelection` et `canonicalSignature`.
 */
function assertWellFormed(selection: readonly SelectedOptionInput[]): void {
  if (selection.length > MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE) {
    throw new ModifierSelectionError(
      'MODIFIER_TOO_MANY',
      `${MODIFIER_LIMITS.MAX_DISTINCT_OPTIONS_PER_LINE} options au maximum par article.`,
    );
  }
  const seen = new Set<string>();
  let total = 0;
  for (const choice of selection) {
    if (
      typeof choice.optionId !== 'string' ||
      !OPTION_ID_PATTERN.test(choice.optionId)
    ) {
      throw new ModifierSelectionError(
        'MODIFIER_FOREIGN',
        'Une option choisie est inconnue.',
      );
    }
    if (
      !Number.isInteger(choice.quantity) ||
      choice.quantity < 1 ||
      choice.quantity > MODIFIER_LIMITS.MAX_OPTION_QUANTITY
    ) {
      throw new ModifierSelectionError(
        'MODIFIER_INVALID_QUANTITY',
        `Quantité d'option invalide (entre 1 et ${MODIFIER_LIMITS.MAX_OPTION_QUANTITY}).`,
      );
    }
    if (seen.has(choice.optionId)) {
      throw new ModifierSelectionError(
        'DUPLICATE_OPTION',
        'Une même option est citée deux fois : indiquez sa quantité une seule fois.',
      );
    }
    seen.add(choice.optionId);
    total += choice.quantity;
  }
  if (total > MODIFIER_LIMITS.MAX_TOTAL_OPTION_QUANTITY_PER_LINE) {
    throw new ModifierSelectionError(
      'MODIFIER_TOO_MANY',
      `${MODIFIER_LIMITS.MAX_TOTAL_OPTION_QUANTITY_PER_LINE} suppléments au maximum par article.`,
    );
  }
}

/** Comparaison par points de code : indépendante de la locale du serveur. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Signature canonique d'une sélection — identité d'une ligne de panier.
 *
 * Refuse ce que `resolveSelection` refuserait pour des raisons de forme
 * (doublon, quantité, identifiant) : deux entrées différentes ne peuvent pas
 * produire la même signature.
 */
export function canonicalSignature(
  selection: readonly SelectedOptionInput[],
): string {
  assertWellFormed(selection);
  return [...selection]
    .sort((a, b) => byCodePoint(a.optionId, b.optionId))
    .map((choice) => `${choice.optionId}:${choice.quantity}`)
    .join(',');
}

function pluralChoices(n: number): string {
  return `${n} choix`;
}

/**
 * Un groupe obligatoire peut-il encore être satisfait ? Faux quand il reste
 * moins d'options vendables que le minimum exigé : le produit est alors
 * indisponible (Q5), à la carte comme au panier.
 */
function isSatisfiable(group: ModifierCatalogGroup): boolean {
  if (group.minSelect <= 0) return true;
  const sellable = group.options.filter(
    (option) => option.deletedAt === null && option.isAvailable,
  ).length;
  return sellable >= group.minSelect;
}

/**
 * Pourquoi ce produit ne peut-il pas être commandé à cause de ses options ?
 * `null` s'il le peut. Sert la carte (produit grisé, Q5) avec la même règle
 * que le panier et le checkout.
 */
export function modifierBlockingReason(
  product: ModifierProductContext,
  modifiersEnabled: boolean,
): string | null {
  if (!modifiersEnabled) return null;
  const blocked = product.groups.find(
    (group) => group.deletedAt === null && !isSatisfiable(group),
  );
  return blocked
    ? `« ${product.productName} » est indisponible : plus aucun choix pour « ${blocked.name} ».`
    : null;
}

/**
 * Résout une sélection contre l'état du catalogue. Lève
 * `ModifierSelectionError` au premier refus.
 */
export function resolveSelection(args: {
  basePriceXaf: number;
  product: ModifierProductContext;
  selection: readonly SelectedOptionInput[];
  modifiersEnabled: boolean;
}): ResolvedSelection {
  const { basePriceXaf, product, selection, modifiersEnabled } = args;

  if (!modifiersEnabled) {
    if (selection.length > 0) {
      throw new ModifierSelectionError(
        'MODIFIERS_DISABLED',
        'Les options ne sont pas proposées pour le moment. Retirez-les puis ajoutez l’article de nouveau.',
      );
    }
    return emptySelection(basePriceXaf);
  }

  assertWellFormed(selection);

  // Groupes vivants attachés au produit, et index option → groupe.
  const groups = product.groups.filter(
    (group) =>
      group.deletedAt === null && group.restaurantId === product.restaurantId,
  );
  const index = new Map<
    string,
    { group: ModifierCatalogGroup; option: ModifierCatalogOption }
  >();
  for (const group of groups) {
    for (const option of group.options) {
      index.set(option.id, { group, option });
    }
  }

  const chosen = new Map<string, number>();
  for (const choice of selection) {
    const hit = index.get(choice.optionId);
    if (!hit) {
      throw new ModifierSelectionError(
        'MODIFIER_FOREIGN',
        `Une option choisie n'est pas proposée pour « ${product.productName} ». Retirez l'article puis ajoutez-le de nouveau.`,
      );
    }
    const { option } = hit;
    if (option.deletedAt !== null) {
      throw new ModifierSelectionError(
        'MODIFIER_UNAVAILABLE',
        `L'option « ${option.name} » n'est plus proposée pour « ${product.productName} ».`,
      );
    }
    if (!option.isAvailable) {
      throw new ModifierSelectionError(
        'MODIFIER_UNAVAILABLE',
        `L'option « ${option.name} » n'est plus disponible pour « ${product.productName} ».`,
      );
    }
    if (choice.quantity > option.maxQuantity) {
      throw new ModifierSelectionError(
        'MODIFIER_INVALID_QUANTITY',
        option.maxQuantity === 1
          ? `« ${option.name} » ne se prend qu'une fois.`
          : `« ${option.name} » : ${option.maxQuantity} au maximum.`,
      );
    }
    chosen.set(option.id, choice.quantity);
  }

  // Cardinalités, groupe par groupe, en options DISTINCTES.
  const lines: ResolvedOptionLine[] = [];
  for (const group of groups) {
    const picked = [...group.options]
      .sort(
        (a, b) => a.displayOrder - b.displayOrder || byCodePoint(a.id, b.id),
      )
      .filter((option) => chosen.has(option.id));
    if (picked.length > group.maxSelect) {
      throw new ModifierSelectionError(
        'MODIFIER_TOO_MANY',
        group.maxSelect === 1
          ? `« ${group.name} » : un seul choix possible.`
          : `« ${group.name} » : ${pluralChoices(group.maxSelect)} au maximum.`,
      );
    }
    if (picked.length < group.minSelect) {
      if (!isSatisfiable(group)) {
        throw new ModifierSelectionError(
          'MODIFIER_UNAVAILABLE',
          `« ${product.productName} » est indisponible : plus aucun choix pour « ${group.name} ».`,
        );
      }
      throw new ModifierSelectionError(
        'MODIFIER_REQUIRED',
        group.minSelect === 1
          ? `Choisissez « ${group.name} » pour « ${product.productName} ». Si ce choix ne vous est pas proposé, mettez à jour l'application.`
          : `Choisissez au moins ${pluralChoices(group.minSelect)} pour « ${group.name} » (« ${product.productName} »). Si ce choix ne vous est pas proposé, mettez à jour l'application.`,
      );
    }
    for (const option of picked) {
      lines.push({
        optionId: option.id,
        groupId: group.id,
        groupName: group.name,
        optionName: option.name,
        priceDeltaXaf: option.priceDeltaXaf,
        quantity: chosen.get(option.id)!,
        position: lines.length,
      });
    }
  }

  const optionsTotalXaf = lines.reduce(
    (sum, line) => sum + line.priceDeltaXaf * line.quantity,
    0,
  );
  if (!Number.isSafeInteger(optionsTotalXaf) || optionsTotalXaf < 0) {
    // Défense : les CHECK en base bornent déjà chaque supplément.
    throw new ModifierSelectionError(
      'MODIFIER_UNAVAILABLE',
      `Le prix des options de « ${product.productName} » est invalide. Contactez le support.`,
    );
  }

  return {
    signature: canonicalSignature(selection),
    optionsTotalXaf,
    unitPriceXaf: basePriceXaf + optionsTotalXaf,
    lines,
  };
}

/**
 * Deux résolutions décrivent-elles la même facture ? Sert le checkout, qui
 * résout une fois hors transaction (calcul des montants) puis une seconde fois
 * sous verrou : si le catalogue a bougé entre les deux, la commande est
 * refusée plutôt que figée sur des montants que plus rien ne justifie.
 */
export function sameResolution(
  a: ResolvedSelection,
  b: ResolvedSelection,
): boolean {
  if (
    a.signature !== b.signature ||
    a.unitPriceXaf !== b.unitPriceXaf ||
    a.optionsTotalXaf !== b.optionsTotalXaf ||
    a.lines.length !== b.lines.length
  ) {
    return false;
  }
  return a.lines.every((line, i) => {
    const other = b.lines[i];
    return (
      line.optionId === other.optionId &&
      line.groupId === other.groupId &&
      line.groupName === other.groupName &&
      line.optionName === other.optionName &&
      line.priceDeltaXaf === other.priceDeltaXaf &&
      line.quantity === other.quantity
    );
  });
}
