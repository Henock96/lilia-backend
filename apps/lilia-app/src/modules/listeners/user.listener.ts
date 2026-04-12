/* eslint-disable prettier/prettier */
import { Injectable,Logger } from "@nestjs/common";
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from "../email/email.service";

@Injectable()
export class UserListener {
  private readonly logger = new Logger(UserListener.name);
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    ) {}
}