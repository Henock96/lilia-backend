/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Envoi d'e-mails transactionnels via **Resend** (août 2026).
 *
 * Remplace Mailtrap. La bascule vaut surtout pour l'invitation vendeur : le
 * plan de test de Mailtrap capture les messages dans une boîte de
 * démonstration au lieu de les livrer, ce qui rendait l'accès au compte d'un
 * vendeur dépendant d'un réglage invisible depuis le code.
 *
 * Le contrat de la classe est inchangé — `isReady()` et `sendEmail()` gardent
 * leur signature, et les trois modèles de message n'ont pas bougé. Seul le
 * transporteur change.
 *
 * ⚠️ Resend n'accepte que des expéditeurs sur un **domaine vérifié** chez lui.
 * `RESEND_SENDER_EMAIL` doit donc porter un domaine dont les enregistrements
 * DNS ont été validés dans la console Resend, sans quoi l'API répond 403 et
 * les envois échouent silencieusement du point de vue de l'appelant (`false`).
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private client: Resend | null = null;
  private senderEmail: string;
  private senderName: string;
  private isConfigured = false;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.senderEmail =
      this.configService.get<string>('RESEND_SENDER_EMAIL') || 'noreply@liliafood.com';
    this.senderName = this.configService.get<string>('RESEND_SENDER_NAME') || 'Lilia Food';

    if (!apiKey) {
      this.logger.warn('⚠️ RESEND_API_KEY absente — service e-mail désactivé.');
      return;
    }

    try {
      this.client = new Resend(apiKey);
      this.isConfigured = true;
      this.logger.log(`✅ Service e-mail initialisé (Resend, expéditeur ${this.senderEmail})`);
    } catch (error) {
      this.logger.error('❌ Initialisation du client Resend impossible :', (error as Error).message);
    }
  }

  isReady(): boolean {
    return this.isConfigured && this.client !== null;
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.isReady()) {
      this.logger.warn('⚠️ Service e-mail non configuré — envoi ignoré.');
      return false;
    }

    try {
      this.logger.log(`📧 Envoi à ${options.to} : ${options.subject}`);

      // Le SDK Resend ne lève pas sur une erreur d'API : il renvoie
      // `{ data, error }`. Sans ce contrôle, un domaine non vérifié ou une clé
      // révoquée produirait un « envoi réussi » parfaitement silencieux — et
      // l'invitation d'un vendeur serait perdue sans que personne ne le sache.
      const { data, error } = await this.client!.emails.send({
        from: `${this.senderName} <${this.senderEmail}>`,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text || this.stripHtml(options.html),
      });

      if (error) {
        this.logger.error(
          `❌ Resend a refusé l'envoi à ${options.to} : ${error.name} — ${error.message}`,
        );
        return false;
      }

      this.logger.log(`✅ E-mail envoyé à ${options.to} (id ${data?.id ?? 'inconnu'})`);
      return true;
    } catch (error) {
      this.logger.error(
        `❌ Échec d'envoi à ${options.to} :`,
        (error as Error).message,
      );
      return false;
    }
  }

  /**
   * Envoie un email de bienvenue à un nouvel utilisateur
   */
  async sendWelcomeEmail(email: string, nom: string): Promise<boolean> {
    const html = this.getWelcomeEmailTemplate(nom);

    return this.sendEmail({
      to: email,
      subject: '🎉 Bienvenue sur Lilia Food !',
      html,
    });
  }

  /**
   * Envoie un email promotionnel pour un nouveau menu
   */
  async sendNewMenuEmail(
    email: string,
    clientName: string,
    menuData: {
      menuName: string;
      restaurantName: string;
      price: number;
      description?: string;
      imageUrl?: string;
    },
  ): Promise<boolean> {
    const html = this.getNewMenuEmailTemplate(clientName, menuData);

    return this.sendEmail({
      to: email,
      subject: `🔥 Nouveau menu chez ${menuData.restaurantName} !`,
      html,
    });
  }

  /**
   * Template email de bienvenue
   */
  private getWelcomeEmailTemplate(nom: string): string {
    return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenue sur Lilia Food</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #FF6B35 0%, #FF8C42 100%); padding: 40px 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: bold;">
          Lilia Food
        </h1>
        <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">
          Votre partenaire gourmand
        </p>
      </td>
    </tr>

    <!-- Main Content -->
    <tr>
      <td style="padding: 40px 30px;">
        <h2 style="color: #333333; margin: 0 0 20px 0; font-size: 24px;">
          Bienvenue ${nom} ! 🎉
        </h2>

        <p style="color: #666666; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
          Nous sommes ravis de vous accueillir sur <strong>Lilia Food</strong> !
          Vous faites maintenant partie de notre communaute de gourmands.
        </p>

        <p style="color: #666666; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">
          Avec Lilia Food, vous pouvez :
        </p>

        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding: 15px; background-color: #FFF5F0; border-radius: 8px; margin-bottom: 15px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50" style="vertical-align: top;">
                    <span style="font-size: 24px;">🍽️</span>
                  </td>
                  <td>
                    <strong style="color: #333333;">Decouvrir des restaurants</strong>
                    <p style="color: #666666; margin: 5px 0 0 0; font-size: 14px;">
                      Explorez les meilleurs restaurants de votre quartier
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height: 15px;"></td></tr>
          <tr>
            <td style="padding: 15px; background-color: #FFF5F0; border-radius: 8px; margin-bottom: 15px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50" style="vertical-align: top;">
                    <span style="font-size: 24px;">📱</span>
                  </td>
                  <td>
                    <strong style="color: #333333;">Commander facilement</strong>
                    <p style="color: #666666; margin: 5px 0 0 0; font-size: 14px;">
                      Passez vos commandes en quelques clics depuis votre mobile
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height: 15px;"></td></tr>
          <tr>
            <td style="padding: 15px; background-color: #FFF5F0; border-radius: 8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50" style="vertical-align: top;">
                    <span style="font-size: 24px;">🚴</span>
                  </td>
                  <td>
                    <strong style="color: #333333;">Livraison rapide</strong>
                    <p style="color: #666666; margin: 5px 0 0 0; font-size: 14px;">
                      Recevez vos repas directement chez vous
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <div style="text-align: center; margin-top: 40px;">
          <p style="color: #666666; font-size: 16px; margin: 0 0 20px 0;">
            Pret a decouvrir de nouvelles saveurs ?
          </p>
          <a href="#" style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #FF8C42 100%); color: #ffffff; text-decoration: none; padding: 15px 40px; border-radius: 30px; font-weight: bold; font-size: 16px;">
            Ouvrir l'application
          </a>
        </div>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8f8f8; padding: 30px; text-align: center; border-top: 1px solid #eeeeee;">
        <p style="color: #999999; font-size: 14px; margin: 0 0 10px 0;">
          Lilia Food - Votre application de livraison preferee
        </p>
        <p style="color: #cccccc; font-size: 12px; margin: 0;">
          Cet email a ete envoye automatiquement. Merci de ne pas y repondre.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  /**
   * Template email nouveau menu
   */
  private getNewMenuEmailTemplate(
    clientName: string,
    menuData: {
      menuName: string;
      restaurantName: string;
      price: number;
      description?: string;
      imageUrl?: string;
    },
  ): string {
    const imageSection = menuData.imageUrl
      ? `
        <tr>
          <td style="padding: 0;">
            <img src="${menuData.imageUrl}" alt="${menuData.menuName}" style="width: 100%; max-height: 250px; object-fit: cover; border-radius: 8px 8px 0 0;" />
          </td>
        </tr>
      `
      : '';

    return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouveau Menu - ${menuData.restaurantName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #FF6B35 0%, #FF8C42 100%); padding: 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: bold;">
          Lilia Food
        </h1>
      </td>
    </tr>

    <!-- Main Content -->
    <tr>
      <td style="padding: 30px;">
        <p style="color: #666666; font-size: 16px; margin: 0 0 20px 0;">
          Bonjour <strong>${clientName}</strong>,
        </p>

        <h2 style="color: #FF6B35; margin: 0 0 20px 0; font-size: 22px; text-align: center;">
          🔥 Nouveau menu disponible !
        </h2>

        <!-- Menu Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #eeeeee; border-radius: 8px; overflow: hidden; margin: 20px 0;">
          ${imageSection}
          <tr>
            <td style="padding: 20px;">
              <p style="color: #999999; font-size: 14px; margin: 0 0 5px 0; text-transform: uppercase;">
                ${menuData.restaurantName}
              </p>
              <h3 style="color: #333333; margin: 0 0 10px 0; font-size: 20px;">
                ${menuData.menuName}
              </h3>
              ${menuData.description ? `<p style="color: #666666; font-size: 14px; margin: 0 0 15px 0;">${menuData.description}</p>` : ''}
              <p style="color: #FF6B35; font-size: 24px; font-weight: bold; margin: 0;">
                ${menuData.price.toLocaleString('fr-FR')} FCFA
              </p>
            </td>
          </tr>
        </table>

        <div style="text-align: center; margin-top: 30px;">
          <a href="#" style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #FF8C42 100%); color: #ffffff; text-decoration: none; padding: 15px 40px; border-radius: 30px; font-weight: bold; font-size: 16px;">
            Commander maintenant
          </a>
        </div>

        <p style="color: #999999; font-size: 14px; text-align: center; margin: 30px 0 0 0;">
          Vous avez deja commande chez ${menuData.restaurantName}, c'est pourquoi nous avons pense que ce nouveau menu pourrait vous interesser !
        </p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background-color: #f8f8f8; padding: 30px; text-align: center; border-top: 1px solid #eeeeee;">
        <p style="color: #999999; font-size: 14px; margin: 0 0 10px 0;">
          Lilia Food - Votre application de livraison preferee
        </p>
        <p style="color: #cccccc; font-size: 12px; margin: 0;">
          Vous recevez cet email car vous etes client de ${menuData.restaurantName}.
          <br />
          <a href="#" style="color: #999999;">Se desabonner</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  /**
   * Invitation d'activation du compte vendeur.
   *
   * Seul canal par lequel un vendeur créé par un administrateur apprend que son
   * espace existe. Avant, l'admin choisissait un mot de passe et le
   * transmettait de vive voix ou par messagerie : un secret partagé, jamais
   * changé, hors de tout contrôle.
   */
  async sendVendorInvitation(
    email: string,
    nom: string,
    boutique: string,
    activationLink: string,
  ): Promise<boolean> {
    return this.sendEmail({
      to: email,
      subject: `Activez votre espace vendeur — ${boutique}`,
      html: this.getVendorInvitationTemplate(nom, boutique, activationLink),
    });
  }

  private getVendorInvitationTemplate(
    nom: string,
    boutique: string,
    link: string,
  ): string {
    return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Votre espace vendeur Lilia Food</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:22px;color:#1a1a1a;">Bienvenue sur Lilia Food, ${this.escape(nom)}</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444;">
            Votre espace vendeur pour <strong>${this.escape(boutique)}</strong> a été créé.
            Pour y accéder, définissez votre mot de passe :
          </p>
          <p style="margin:24px 0;text-align:center;">
            <a href="${link}" style="display:inline-block;background:#e85d04;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;font-weight:bold;">
              Définir mon mot de passe
            </a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#777;">
            Ce lien est personnel et à usage unique. Si le bouton ne fonctionne pas,
            copiez cette adresse dans votre navigateur :
          </p>
          <p style="margin:0 0 24px;font-size:12px;color:#999;word-break:break-all;">${link}</p>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#444;">
            Une fois connecté, vous pourrez compléter vos horaires, vos photos et votre
            catalogue. Votre boutique ne sera visible des clients qu'après validation.
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#999;">Lilia Food — Brazzaville</p>
    </td></tr>
  </table>
</body>
</html>
    `.trim();
  }

  /**
   * Neutralise le HTML dans les valeurs interpolées. `nom` et `boutique` sont
   * saisis par un administrateur dans un formulaire : sans échappement, un
   * apostrophe ou un chevron casserait la mise en page, et une balise injectée
   * partirait telle quelle dans la boîte du destinataire.
   */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Supprime les balises HTML d'un texte (pour la version texte de l'email)
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
