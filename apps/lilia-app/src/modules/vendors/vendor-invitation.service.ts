import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';

export interface InvitationResult {
  emailSent: boolean;
  smsSent: boolean;
  /**
   * Lien d'activation, retourné **uniquement** quand l'e-mail n'est pas parti.
   *
   * C'est un repli assumé, pas une commodité : si Mailtrap est mal configuré ou
   * en panne, l'alternative serait un vendeur qui ne peut pas accéder à son
   * compte et un administrateur sans aucun moyen de le débloquer. Le lien
   * expire selon la politique Firebase et ne vaut que pour cette adresse.
   */
  activationLink?: string;
  /** Message prêt à afficher à l'administrateur. */
  detail: string;
}

/**
 * Invitation d'activation du compte vendeur.
 *
 * Remplace la transmission manuelle d'un mot de passe choisi par
 * l'administrateur. Le principe : l'admin crée le compte, il n'en détient
 * jamais le secret. `generatePasswordResetLink` produit un lien signé par
 * Firebase que seul le destinataire peut consommer.
 *
 * ⚠️ Le SDK Admin **génère** le lien, il ne l'envoie pas : l'acheminement est à
 * notre charge, d'où l'appel explicite à `EmailService`.
 */
@Injectable()
export class VendorInvitationService {
  private readonly logger = new Logger(VendorInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
  ) {}

  async sendForVendor(restaurantId: string): Promise<InvitationResult> {
    const vendor = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        nom: true,
        owner: { select: { email: true, nom: true, phone: true } },
      },
    });
    if (!vendor) throw new NotFoundException('Vendeur introuvable.');

    return this.send({
      email: vendor.owner.email,
      nom: vendor.owner.nom ?? vendor.nom,
      phone: vendor.owner.phone,
      boutique: vendor.nom,
    });
  }

  async send(params: {
    email: string;
    nom: string;
    phone?: string | null;
    boutique: string;
  }): Promise<InvitationResult> {
    let link: string;
    try {
      link = await this.firebase.generatePasswordResetLink(params.email);
    } catch (err) {
      // Sans lien, il n'y a pas d'invitation possible. On remonte l'échec au
      // lieu de rendre un succès trompeur : l'admin doit savoir que le vendeur
      // n'a aucun moyen d'accéder à son compte.
      this.logger.error(
        `Génération du lien d'activation impossible pour ${params.email} : ${
          (err as Error).message
        }`,
      );
      return {
        emailSent: false,
        smsSent: false,
        detail:
          "Le lien d'activation n'a pas pu être généré. Le vendeur ne peut pas encore se connecter — réessayez depuis sa fiche.",
      };
    }

    const emailSent = await this.email.sendVendorInvitation(
      params.email,
      params.nom,
      params.boutique,
      link,
    );

    // Le SMS ne porte pas le lien : une URL Firebase dépasse 200 caractères,
    // soit deux à trois segments facturés, et se tronque dans plusieurs clients
    // SMS. Il sert d'accusé — « votre espace existe, regardez vos e-mails » —
    // sur le canal qui arrive le plus sûrement à Brazzaville.
    const smsSent = params.phone
      ? await this.sms.send(
          params.phone,
          `Lilia Food : votre espace vendeur "${params.boutique.slice(0, 30)}" est cree. Consultez votre email (${params.email}) pour definir votre mot de passe.`,
        )
      : false;

    if (emailSent) {
      this.logger.log(`Invitation vendeur envoyée à ${params.email}`);
      return {
        emailSent,
        smsSent,
        detail: `Invitation envoyée à ${params.email}.`,
      };
    }

    this.logger.warn(
      `Invitation non acheminée pour ${params.email} — lien remis à l'administrateur`,
    );
    return {
      emailSent: false,
      smsSent,
      activationLink: link,
      detail:
        "L'e-mail n'a pas pu être envoyé. Transmettez ce lien d'activation au vendeur par un canal sûr.",
    };
  }
}
