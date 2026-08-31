import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  createVerify,
  KeyObject,
} from 'crypto';

/**
 * Vérification des callbacks signés par pawaPay (RFC-9421 — HTTP Message
 * Signatures), telle que décrite dans leur documentation « Signatures in
 * callbacks ».
 *
 * Un callback signé porte cinq en-têtes :
 *   Content-Digest   sha-256=:base64:  ou  sha-512=:base64:
 *   Signature        sig-pp=:base64:
 *   Signature-Input  sig-pp=("@method" "@authority" "@path" "signature-date"
 *                            "content-digest" "content-type");alg="…";keyid="…"
 *   Signature-Date   horodatage de création de la signature
 *   Content-Type     application/json; charset=UTF-8
 *
 * Deux contrôles, dans cet ordre :
 *  1. **intégrité du contenu** — le digest recalculé sur le corps BRUT doit
 *     correspondre à `Content-Digest` ;
 *  2. **authenticité** — la signature doit vérifier la « signature base »
 *     reconstruite selon `Signature-Input`, avec la clé publique de pawaPay.
 *
 * ⚠️ Le corps brut est indispensable : re-sérialiser l'objet JSON parsé produit
 * des octets différents (ordre des clés, espaces, échappement Unicode) et le
 * digest ne correspond jamais. D'où `rawBody: true` dans `main.ts`.
 *
 * **Fail-closed** : si la vérification est activée et qu'un élément manque, on
 * refuse. Un endpoint public qui mute des lignes d'argent ne doit jamais
 * accorder le bénéfice du doute.
 */
@Injectable()
export class PawaPaySignatureService {
  private readonly logger = new Logger(PawaPaySignatureService.name);

  /**
   * Tolérance d'horloge sur `Signature-Date`, en secondes.
   *
   * Sert de protection anti-rejeu : un callback capté et renvoyé plus tard est
   * refusé. 5 minutes couvrent une dérive d'horloge réaliste entre Render et
   * pawaPay sans ouvrir une fenêtre de rejeu exploitable. Le journal
   * `PaymentEvent` et l'`updateMany` conditionnel constituent les deux autres
   * lignes de défense.
   */
  private static readonly MAX_SIGNATURE_AGE_SECONDS = 300;

  constructor(private readonly config: ConfigService) {}

  /**
   * La vérification est-elle exigée ?
   *
   * Elle l'est dès qu'une clé publique est configurée. pawaPay rend les
   * callbacks signés **optionnels** (à activer dans leur tableau de bord) : sans
   * clé, on ne peut pas vérifier, et le contrôleur bascule alors sur la seule
   * protection restante — la liste blanche d'adresses IP.
   */
  get isEnabled(): boolean {
    return Boolean(this.publicKeyPem());
  }

  private publicKeyPem(): string | undefined {
    const raw = this.config.get<string>('PAWAPAY_PUBLIC_KEY');
    if (!raw?.trim()) return undefined;
    // Les variables d'environnement de Render échappent les sauts de ligne.
    return raw.replace(/\\n/g, '\n');
  }

  /**
   * Vérifie un callback. Retourne un motif de refus, ou `null` si tout est bon.
   *
   * Le motif est destiné aux logs, jamais à la réponse HTTP : détailler à
   * l'appelant *pourquoi* sa signature est refusée l'aiderait à en forger une.
   */
  verify(params: {
    method: string;
    authority: string;
    path: string;
    rawBody: Buffer | string | undefined;
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    const pem = this.publicKeyPem();
    if (!pem) return 'no-public-key-configured';

    const header = (name: string): string | undefined => {
      const value = params.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };

    const signature = header('signature');
    const signatureInput = header('signature-input');
    const contentDigest = header('content-digest');
    const signatureDate = header('signature-date');
    const contentType = header('content-type');

    if (!signature || !signatureInput || !contentDigest || !signatureDate) {
      return 'missing-signature-headers';
    }
    if (!params.rawBody) {
      // Sans corps brut, aucune vérification n'est possible. Refuser plutôt que
      // de vérifier sur une re-sérialisation, qui échouerait de toute façon.
      return 'missing-raw-body';
    }

    // ── 1. Intégrité du contenu ───────────────────────────────────────────────
    const digestError = this.verifyContentDigest(contentDigest, params.rawBody);
    if (digestError) return digestError;

    // ── 2. Fraîcheur (anti-rejeu) ─────────────────────────────────────────────
    const dateError = this.verifySignatureDate(signatureDate);
    if (dateError) return dateError;

    // ── 3. Authenticité ───────────────────────────────────────────────────────
    const label = this.extractLabel(signatureInput);
    if (!label) return 'unparsable-signature-input';

    const covered = this.extractCoveredComponents(signatureInput, label);
    if (!covered) return 'unparsable-covered-components';

    const signatureParams = this.extractSignatureParams(signatureInput, label);
    if (!signatureParams) return 'unparsable-signature-params';

    const base = this.buildSignatureBase({
      covered,
      signatureParams,
      method: params.method,
      authority: params.authority,
      path: params.path,
      headerValues: {
        'signature-date': signatureDate,
        'content-digest': contentDigest,
        'content-type': contentType ?? '',
      },
    });
    if (base === null) return 'unsupported-covered-component';

    const rawSignature = this.extractByteSequence(signature, label);
    if (!rawSignature) return 'unparsable-signature-value';

    const algorithm = this.extractAlg(signatureInput, label);
    const verifier = this.nodeAlgorithmFor(algorithm);
    if (!verifier) return `unsupported-algorithm:${algorithm ?? 'none'}`;

    try {
      const key: KeyObject = createPublicKey(pem);
      const ok = createVerify(verifier.hash)
        .update(base, 'utf8')
        .verify(
          verifier.pss
            ? {
                key,
                padding: verifier.padding,
                saltLength: verifier.saltLength,
              }
            : { key, dsaEncoding: 'der' },
          rawSignature,
        );
      return ok ? null : 'signature-mismatch';
    } catch (error) {
      this.logger.error(
        `Vérification de signature impossible : ${(error as Error).message}`,
      );
      return 'verification-error';
    }
  }

  private verifyContentDigest(
    contentDigest: string,
    rawBody: Buffer | string,
  ): string | null {
    // Format : `sha-512=:BASE64:` (éventuellement plusieurs, séparés par des
    // virgules — on retient le premier algorithme reconnu).
    const match = /(sha-256|sha-512)=:([^:]+):/i.exec(contentDigest);
    if (!match) return 'unparsable-content-digest';

    const algorithm =
      match[1].toLowerCase() === 'sha-256' ? 'sha256' : 'sha512';
    const expected = match[2];
    const actual = createHash(algorithm)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'))
      .digest('base64');

    return actual === expected ? null : 'content-digest-mismatch';
  }

  private verifySignatureDate(signatureDate: string): string | null {
    const parsed = Date.parse(signatureDate);
    if (Number.isNaN(parsed)) return 'unparsable-signature-date';
    const ageSeconds = Math.abs(Date.now() - parsed) / 1000;
    return ageSeconds > PawaPaySignatureService.MAX_SIGNATURE_AGE_SECONDS
      ? 'signature-too-old'
      : null;
  }

  /** `sig-pp=("@method" …);alg="…"` → `sig-pp`. */
  private extractLabel(signatureInput: string): string | null {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(signatureInput);
    return match ? match[1] : null;
  }

  /** Liste ordonnée des composants couverts, telle que déclarée. */
  private extractCoveredComponents(
    signatureInput: string,
    label: string,
  ): string[] | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*=\\s*\\(([^)]*)\\)`).exec(
      signatureInput,
    );
    if (!match) return null;
    const components = match[1]
      .split(/\s+/)
      .map((c) => c.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    return components.length > 0 ? components : null;
  }

  /** Tout ce qui suit la parenthèse fermante : `;alg="…";keyid="…";created=…`. */
  private extractSignatureParams(
    signatureInput: string,
    label: string,
  ): string | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*=\\s*(\\([^)]*\\).*)$`).exec(
      signatureInput.trim(),
    );
    return match ? match[1] : null;
  }

  private extractAlg(signatureInput: string, label: string): string | null {
    const params = this.extractSignatureParams(signatureInput, label);
    if (!params) return null;
    const match = /alg="([^"]+)"/.exec(params);
    return match ? match[1] : null;
  }

  /** `sig-pp=:BASE64:` → Buffer. */
  private extractByteSequence(value: string, label: string): Buffer | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*=\\s*:([^:]+):`).exec(value);
    if (!match) return null;
    try {
      return Buffer.from(match[1], 'base64');
    } catch {
      return null;
    }
  }

  /**
   * Reconstruit la « signature base » de RFC-9421 : une ligne par composant
   * couvert, dans l'ordre déclaré, puis `"@signature-params"`.
   *
   * Retourne `null` si un composant couvert n'est pas géré — on refuse plutôt
   * que de vérifier une base incomplète, qui validerait une requête dont une
   * partie n'a pas été signée.
   */
  private buildSignatureBase(input: {
    covered: string[];
    signatureParams: string;
    method: string;
    authority: string;
    path: string;
    headerValues: Record<string, string>;
  }): string | null {
    const lines: string[] = [];

    for (const component of input.covered) {
      switch (component) {
        case '@method':
          lines.push(`"@method": ${input.method.toUpperCase()}`);
          break;
        case '@authority':
          lines.push(`"@authority": ${input.authority}`);
          break;
        case '@path':
          lines.push(`"@path": ${input.path}`);
          break;
        default: {
          const value = input.headerValues[component.toLowerCase()];
          if (value === undefined) return null;
          lines.push(`"${component.toLowerCase()}": ${value}`);
        }
      }
    }

    lines.push(`"@signature-params": ${input.signatureParams}`);
    return lines.join('\n');
  }

  /**
   * Algorithmes RFC-9421 acceptés, restreints à ceux que pawaPay annonce dans
   * son en-tête `Accept-Signature`.
   */
  private nodeAlgorithmFor(alg: string | null): {
    hash: string;
    pss: boolean;
    padding?: number;
    saltLength?: number;
  } | null {
    switch (alg) {
      case 'ecdsa-p256-sha256':
        return { hash: 'sha256', pss: false };
      case 'ecdsa-p384-sha384':
        return { hash: 'sha384', pss: false };
      case 'rsa-v1_5-sha256':
        return { hash: 'sha256', pss: false };
      case 'rsa-pss-sha512':
        return {
          hash: 'sha512',
          pss: true,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 64,
        };
      default:
        return null;
    }
  }
}
