import { Injectable, Logger } from '@nestjs/common';
import { Role, StatusUser } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from './notifications.service';

export interface AdminAlert {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Lien profond vers l'écran concerné, ajouté au corps de l'e-mail.
   * Le push porte déjà `data` ; l'e-mail, lui, doit se suffire à lui-même.
   */
  href?: string;
}

export interface AdminAlertResult {
  admins: number;
  pushed: number;
  emailed: number;
}

/**
 * Alertes opérationnelles destinées aux administrateurs — **point unique**.
 *
 * ## Pourquoi ce service existe
 *
 * Deux fan-out admin coexistaient, recopiés à la main : `VendorsListener
 * .notifyAdmins` et `IncidentsNotificationListener.pushToAllAdmins`. Tous deux
 * corrects, tous deux **muets en production** : le 4 septembre 2026, les trois
 * comptes ADMIN totalisaient **zéro token FCM** (45 côté clients, 7 côté
 * vendeurs, 4 côté livreurs). Les alertes « vendeur à valider », « boutique
 * prête » et « incident » partaient correctement et n'atteignaient personne.
 *
 * La cause n'est pas un bug d'enregistrement : c'est que **les administrateurs
 * travaillent depuis l'administration web**, qui n'enregistre aucun token FCM
 * — seules les trois applications Flutter le font. Un administrateur qui n'a
 * jamais ouvert l'application mobile n'a, structurellement, aucun canal push.
 *
 * ## La règle posée
 *
 * Une alerte d'exploitation ne repose pas sur un seul canal. Le push reste le
 * chemin rapide ; l'e-mail est le chemin **qui existe toujours**, puisqu'un
 * compte administrateur a nécessairement une adresse. Les deux partent, et
 * l'appelant apprend combien de chacun est réellement parti — c'est ce qui
 * manquait pour que le silence soit visible.
 *
 * On ne construit pas un canal de plus : ce service assemble les deux qui
 * existent déjà (`NotificationsService`, `EmailService`).
 */
@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  /**
   * Diffuse une alerte à tous les administrateurs actifs.
   *
   * Ne lève jamais : une alerte est un effet de bord d'un geste métier déjà
   * accompli (le vendeur *est* créé, l'incident *est* ouvert). La faire
   * échouer défairait quelque chose de plus important qu'elle.
   */
  async notify(alert: AdminAlert): Promise<AdminAlertResult> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, statusUser: StatusUser.ACTIVE },
      select: { id: true, email: true, nom: true },
    });

    if (admins.length === 0) {
      // Distinct de « personne n'a de token » : ici il n'y a personne du tout.
      this.logger.error(
        `Aucun administrateur ACTIVE — alerte perdue : ${alert.title}`,
      );
      return { admins: 0, pushed: 0, emailed: 0 };
    }

    const [pushed, emailed] = await Promise.all([
      this.push(admins, alert),
      this.mail(admins, alert),
    ]);

    if (pushed === 0 && emailed === 0) {
      // Les deux canaux muets : l'alerte n'a atteint personne. C'est le seul
      // cas qui mérite un `error` — il annonce qu'une décision attendue d'un
      // humain ne sera prise par personne.
      this.logger.error(
        `Alerte administrateur non distribuée (0 push, 0 e-mail sur ` +
          `${admins.length} admin(s)) : ${alert.title}`,
      );
    } else if (pushed === 0) {
      this.logger.warn(
        `Aucun push administrateur (0 token sur ${admins.length} compte(s)) — ` +
          `repli e-mail utilisé : ${alert.title}`,
      );
    }

    return { admins: admins.length, pushed, emailed };
  }

  private async push(
    admins: { id: string }[],
    alert: AdminAlert,
  ): Promise<number> {
    const results = await Promise.allSettled(
      admins.map((admin) =>
        this.notifications.sendPushNotification(
          admin.id,
          alert.title,
          alert.body,
          alert.data,
        ),
      ),
    );
    return results.filter((r) => r.status === 'fulfilled').length;
  }

  private async mail(
    admins: { email: string | null; nom: string | null }[],
    alert: AdminAlert,
  ): Promise<number> {
    if (!this.email.isReady()) return 0;

    // Les comptes anonymisés portent une adresse `@deleted.liliafood.com` :
    // leur écrire ne servirait qu'à faire rebondir des messages.
    const recipients = admins
      .map((a) => a.email)
      .filter((e): e is string => !!e && !e.endsWith('@deleted.liliafood.com'));

    const results = await Promise.allSettled(
      recipients.map((to) =>
        this.email.sendEmail({
          to,
          subject: `[Lilia Food] ${stripEmoji(alert.title)}`,
          html: this.template(alert),
        }),
      ),
    );
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  private template(alert: AdminAlert): string {
    const link = alert.href
      ? `<p style="margin:24px 0 0"><a href="${alert.href}" style="background:#e0483a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Ouvrir l’administration</a></p>`
      : '';
    return `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1c1917">
        <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#78716c;margin:0 0 8px">Alerte administration</p>
        <h1 style="font-size:19px;margin:0 0 12px">${escapeHtml(alert.title)}</h1>
        <p style="font-size:15px;line-height:1.55;margin:0">${escapeHtml(alert.body)}</p>
        ${link}
        <p style="font-size:12px;color:#a8a29e;margin:28px 0 0;border-top:1px solid #e7e5e4;padding-top:12px">
          Message automatique — vous le recevez parce que votre compte Lilia Food a le rôle administrateur.
        </p>
      </div>`;
  }
}

/** Les émojis passent mal dans les objets d'e-mail selon les clients. */
function stripEmoji(text: string): string {
  // Les plages couvrent les pictogrammes ; `FE0F` (sélecteur de variante) est
  // retiré à part — un caractère combinant dans une classe est ambigu.
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\u{FE0F}/gu, '')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
