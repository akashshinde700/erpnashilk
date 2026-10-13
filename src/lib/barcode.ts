/**
 * Dependency-free Code 128 (code set B) barcode encoder → SVG markup.
 * Code set B covers printable ASCII 32–126, which is enough for item codes and EAN-like numbers.
 */

// Bar/space module widths for symbol values 0–106 (103 = Start A, 104 = Start B, 105 = Start C, 106 = Stop).
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ')

const START_B = 104
const STOP = 106
const QUIET = 10 // quiet zone each side, in modules

/** Symbol values (start, data, checksum, stop) for `text` in code set B. */
export function code128Values(text: string): number[] {
  if (!text) throw new Error('Barcode text is empty')
  const data: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 32 || c > 126) throw new Error(`Character "${ch}" cannot be encoded in Code 128 (only printable ASCII)`)
    data.push(c - 32)
  }
  const checksum = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103
  return [START_B, ...data, checksum, STOP]
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Code 128-B barcode as an SVG string (with quiet zones and optional human-readable text).
 * Throws for characters outside printable ASCII 32–126.
 */
export function code128Svg(text: string, { height = 40, moduleWidth = 1.5, showText = true }: { height?: number; moduleWidth?: number; showText?: boolean } = {}): string {
  const values = code128Values(text)
  const widths = values.map((v) => PATTERNS[v]).join('')
  const totalModules = QUIET * 2 + [...widths].reduce((s, w) => s + Number(w), 0)
  const fontSize = Math.max(8, Math.round(height * 0.28))
  const textGap = showText ? fontSize + 3 : 0
  const w = +(totalModules * moduleWidth).toFixed(2)
  const h = height + textGap

  let x = QUIET
  let bars = ''
  for (let i = 0; i < widths.length; i++) {
    const m = Number(widths[i])
    if (i % 2 === 0) bars += `<rect x="${+(x * moduleWidth).toFixed(2)}" y="0" width="${+(m * moduleWidth).toFixed(2)}" height="${height}"/>`
    x += m
  }
  const label = showText
    ? `<text x="${w / 2}" y="${height + fontSize}" text-anchor="middle" font-family="monospace" font-size="${fontSize}">${escXml(text)}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">` +
    `<rect width="${w}" height="${h}" fill="#fff"/><g fill="#000">${bars}${label}</g></svg>`
}
