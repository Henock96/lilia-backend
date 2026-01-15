/* eslint-disable prettier/prettier */

// Event de base pour tous les menus
export abstract class BaseMenuEvent {
  constructor(
    public readonly menuId: string,
    public readonly restaurantId: string,
    public readonly timestamp: Date = new Date(),
  ) {}
}

// Event pour la création d'un menu
export class MenuCreatedEvent extends BaseMenuEvent {
  constructor(
    menuId: string,
    restaurantId: string,
    public readonly menuData: {
      nom: string;
      description?: string;
      prix: number;
      imageUrl?: string;
      restaurantName: string;
      dateDebut: Date;
      dateFin: Date;
      productCount: number; // Nombre de produits dans le menu
    },
    timestamp?: Date,
  ) {
    super(menuId, restaurantId, timestamp);
  }
}

// Event pour la mise à jour d'un menu
export class MenuUpdatedEvent extends BaseMenuEvent {
  constructor(
    menuId: string,
    restaurantId: string,
    public readonly updatedBy: string, // ID de l'utilisateur qui a fait la mise à jour
    public readonly changes: string[], // Liste des champs modifiés
    timestamp?: Date,
  ) {
    super(menuId, restaurantId, timestamp);
  }
}

// Event pour l'activation/désactivation d'un menu
export class MenuStatusToggledEvent extends BaseMenuEvent {
  constructor(
    menuId: string,
    restaurantId: string,
    public readonly isActive: boolean,
    public readonly toggledBy: string,
    timestamp?: Date,
  ) {
    super(menuId, restaurantId, timestamp);
  }
}

// Event pour la suppression d'un menu
export class MenuDeletedEvent extends BaseMenuEvent {
  constructor(
    menuId: string,
    restaurantId: string,
    public readonly deletedBy: string,
    timestamp?: Date,
  ) {
    super(menuId, restaurantId, timestamp);
  }
}
