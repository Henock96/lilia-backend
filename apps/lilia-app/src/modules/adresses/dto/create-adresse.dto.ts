import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsLatitude,
  IsLongitude,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateAdresseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  rue: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ville: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  etat?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  country: string;

  /**
   * Quartier de l'adresse — **obligatoire**.
   *
   * ## Pourquoi il ne peut plus être omis
   *
   * Le quartier n'est pas qu'une clé de tarification : c'est le **repli de
   * niveau 2** de `DeliveryDestinationService`. Sans position posée à la main,
   * la commande prend le centroïde du quartier et sort en `APPROXIMATE` ; sans
   * quartier, elle sort en `UNKNOWN` et **part sans destination** — le livreur
   * n'a qu'un texte libre, dans une ville où le géocodage inverse rend un Plus
   * Code trois fois sur cinq et où « Avenue de la Paix, Brazzaville » résout à
   * Kinshasa.
   *
   * Mesuré en production le 20/09/2026 : **20 adresses sur 45 n'ont aucun
   * quartier**, toutes créées entre juillet 2025 et mars 2026. Depuis avril,
   * plus aucune — parce que les deux interfaces l'exigent. Mais elles seules :
   * ce DTO l'acceptait toujours absent, si bien que la garantie reposait sur
   * deux formulaires et qu'un troisième appelant, un ancien binaire ou un appel
   * direct à l'API pouvait continuer de créer des adresses non situables.
   *
   * **Une règle qui ne vit que dans l'interface n'est pas une règle.** Elle est
   * ici, où rien ne la contourne.
   *
   * ## Compatibilité
   *
   * Les deux clients l'envoient déjà (`address_page.dart` refuse de soumettre
   * sans lui, `profil/page.tsx` de même). Les binaires antérieurs sont exclus
   * par `PlatformSettings.minAppVersion`. Le service vérifie ensuite que le
   * quartier **existe** et qu'il appartient à la ville déclarée
   * (`assertQuartierMatchesCity`) — l'obligation porte sur la présence, la
   * validation sur le contenu.
   */
  // `@Transform` avant `@IsNotEmpty` : sans lui, `"   "` franchit la
  // validation (la chaîne n'est pas vide) et n'échoue qu'au contrôle
  // d'existence, avec « Quartier inconnu » — un message qui envoie chercher un
  // quartier disparu là où le formulaire a simplement été mal rempli.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({
    message:
      'Le quartier est obligatoire : sans lui, votre commande partirait sans ' +
      'destination pour le livreur.',
  })
  quartierId: string;

  // ── Position de l'adresse ─────────────────────────────────────────────
  // `@IsLatitude` / `@IsLongitude` rejettent NaN et Infinity, que `@IsNumber`
  // laisse passer. Les bornes Congo, l'inversion lat/lng et le point (0, 0)
  // sont vérifiés dans le service, qui peut rendre un message expliquant quoi
  // corriger — un décorateur ne sait dire que « invalide ».
  //
  // Optionnelles, et elles doivent le rester : exiger un point sur carte
  // fermerait la création d'adresse à qui n'a pas de GPS, refuse la
  // permission, ou se trouve à l'intérieur d'un bâtiment. Le quartier suffit à
  // garantir une destination ; la position la précise.
  @IsOptional()
  @IsLatitude({ message: 'Latitude invalide.' })
  @Type(() => Number)
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Longitude invalide.' })
  @Type(() => Number)
  longitude?: number;

  /** Repères pour le livreur : « portail bleu face à la pharmacie ». */
  @IsString()
  @IsOptional()
  @MaxLength(300, {
    message: 'Les repères sont limités à 300 caractères',
  })
  landmark?: string;

  /** Nom donné par le client : « Maison », « Bureau ». */
  @IsString()
  @IsOptional()
  @MaxLength(50)
  label?: string;
}
