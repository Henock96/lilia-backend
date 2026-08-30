import type { TDocumentDefinitions } from 'pdfmake/interfaces';

// pdfmake 0.3 : le module exporte une instance unifiée client/serveur.
// API serveur = setFonts(...) puis createPdf(doc).getBuffer().
// Compilation NestJS = CommonJS, donc require est disponible.

// pdfmake 0.3 n'expose pas d'export ESM utilisable côté serveur : un `import`
// casse la résolution des polices au build webpack. Le require est intentionnel.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMake = require('pdfmake');
// Descripteur de polices Roboto bundlé (chemins .ttf absolus dans node_modules).

// eslint-disable-next-line @typescript-eslint/no-require-imports -- idem ci-dessus
const robotoFonts = require('pdfmake/fonts/Roboto.js');

pdfMake.setFonts(robotoFonts);
// On ne référence aucune ressource externe ni fichier local arbitraire dans nos
// reçus : on interdit les URLs et on n'autorise en lecture locale que le dossier
// des polices pdfmake.
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((path: string) => path.includes('pdfmake'));

/** Rend un docDefinition pdfmake en Buffer PDF. */
export function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  return pdfMake.createPdf(doc).getBuffer();
}
