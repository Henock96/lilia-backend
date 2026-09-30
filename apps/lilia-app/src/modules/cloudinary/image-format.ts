/**
 * Formats d'image acceptés par `POST /upload/image`, tels que les rend
 * `FileTypeValidator` — c'est-à-dire lus dans le **contenu** du fichier
 * (nombre magique), pas dans le type déclaré par le navigateur.
 *
 * HEIC / HEIF : format par défaut des photos d'iPhone depuis iOS 11. Refusé
 * jusqu'ici, alors que c'est ce que produit l'appareil de la majorité des
 * vendeurs qui photographient leur carte. Accepté, puis CONVERTI en JPG à
 * l'enregistrement (voir `isHeif`).
 */
export const ACCEPTED_IMAGE_TYPES = /^image\/(jpeg|jpg|png|webp|heic|heif)$/;

/** Marques ISO-BMFF d'une image HEIF (ISO/IEC 23008-12). */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/**
 * Le fichier est-il une image HEIF/HEIC ?
 *
 * Lu dans la boîte `ftyp` du conteneur : marque principale HEIF, et pas
 * d'AVIF parmi les marques compatibles. Un AVIF est lui aussi un conteneur
 * HEIF (`mif1`), mais c'est un autre codec — et il n'est pas accepté ici.
 *
 * Sert à décider la conversion : Chrome, Firefox et les WebView Android
 * n'affichent PAS le HEIC. Stocké tel quel, il serait accepté à l'envoi puis
 * invisible sur le site et dans les apps.
 */
export function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString('latin1', 4, 8) !== 'ftyp') {
    return false;
  }
  const major = buffer.toString('latin1', 8, 12);
  const boxEnd = Math.min(buffer.readUInt32BE(0), buffer.length);
  const compatible: string[] = [];
  for (let i = 16; i + 4 <= boxEnd; i += 4) {
    compatible.push(buffer.toString('latin1', i, i + 4));
  }
  if (major === 'avif' || major === 'avis' || compatible.includes('avif')) {
    return false;
  }
  return HEIF_BRANDS.has(major);
}
