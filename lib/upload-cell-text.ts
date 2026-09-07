/**
 * One cell of an uploaded spreadsheet, as text safe to send to Snowflake.
 *
 * PURE, NO I/O — the caller is a ~9,500-line component and the failure mode
 * here is silent, so the decision lives in a module a test can pin.
 *
 * -----------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY IT WAS INVISIBLE
 *
 * The campaign upload parses the workbook with
 *
 *     XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false })
 *
 * and `raw: false` asks SheetJS for each cell's FORMATTED TEXT — literally what
 * Excel renders on screen. Excel's General format switches to scientific
 * notation at 12 or more digits, so in one MTN Save file an 11-digit `msisdn`
 * came through as `27784599742` and a 13-digit `id_number` came through as
 *
 *     6.31008E+12
 *
 * That string is what got quoted into the INSERT. Nothing errored: the stage
 * column is VARCHAR, so Snowflake stored the text as given. Downstream, every
 * join on the ID number silently matched nothing — the XDS contact-number
 * enrichment, the credit-risk join via UDM17, the INVALID ID check. A campaign
 * that reported success and dialled nobody's real number.
 *
 * AND IT CANNOT BE REPAIRED AFTER THE FACT. `6.31008E+12` keeps 6 of the 13
 * significant digits; the other 7 are gone. No SQL can rebuild them. So the
 * only place to fix it is here, before the value is sent.
 *
 * -----------------------------------------------------------------------------
 * WHY NOT JUST SWITCH TO `raw: true`
 *
 * Two reasons, both load bearing:
 *
 *  1. The workbook is read with `cellDates: true`, so with `raw: true` a date
 *     cell arrives as a JS Date and String() yields
 *     "Sat Aug 15 2026 00:00:00 GMT+0200 (South Africa Standard Time)".
 *     `contract_end_date` would break in exchange for fixing `id_number`.
 *  2. lib/spot-upload-parse.ts:25-46 is a MEASURED write-up of this same
 *     trade-off for the Spot files, and it chose `raw: false` deliberately:
 *     underlying values silently rewrote the CSV cell "2,50%" as 2.5. This
 *     upload path is shared by every campaign, so flipping the flag would
 *     reopen that.
 *
 * So the rule is narrower than a flag: keep the formatted text, EXCEPT where
 * that text is in exponential notation and the underlying value is a finite
 * number. The blast radius is then exactly the set of cells that are currently
 * wrong, and every other cell is byte-identical to before.
 */

/**
 * Exponential notation as Excel's General format produces it: `6.31008E+12`,
 * `6E+12`, `1.2e-07`.
 *
 * ANCHORED AT BOTH ENDS, which is the whole point. `MTN Mega Flex R135 TopUp`
 * contains an "e" and must not be treated as a number, and neither must an
 * account number like `BA114056959`.
 */
const EXPONENTIAL = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/

/**
 * Is this number's full value actually knowable?
 *
 * Excel stores 15 significant decimal digits. Past that the workbook ITSELF has
 * already rounded, so the underlying value is no more truthful than the
 * scientific-notation text — a 17-digit identifier read back from Excel has two
 * wrong digits whatever we do with it. Those cells are flagged rather than
 * quietly trusted; see `cellText` for what is emitted for them and why.
 *
 * 1e15 rather than Number.isSafeInteger (~9.007e15) on purpose: the binding
 * constraint is Excel's precision, not the double's.
 */
export function isTrustworthy(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) < 1e15
}

/**
 * A number as digits, never in exponential notation.
 *
 * String() is *nearly* right — JS only reaches for an exponent at 1e21 and
 * above or below 1e-6 — but "nearly" is what produced the bug this module
 * exists for, so the choice is explicit and pinned by a test rather than
 * inherited from String's formatting rules.
 */
export function plainNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  // The common case: an identifier, an account number, a usage count.
  // toFixed(0) itself returns "1e+21" at that magnitude, hence the guard.
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(0)

  const s = String(v)
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s)
  // Already plain — String() only uses an exponent outside the range above.
  if (!m) return s

  const [, sign, intPart, fracPart = "", expStr] = m
  const digits = intPart + fracPart
  // Where the decimal point lands once the exponent is applied. String()
  // emits a shortest-round-trip mantissa, so `digits` carries no padding to
  // strip and this arithmetic is exact.
  const point = intPart.length + Number(expStr)

  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

export type CellText = {
  /** What to send to Snowflake. */
  text: string
  /** The formatted text was exponential and the raw value was used instead. */
  repaired: boolean
  /** Beyond Excel's 15 significant digits, so the file itself is unreliable. */
  untrusted: boolean
}

/**
 * Choose between a cell's formatted text and its underlying value.
 *
 * `formatted` is the cell from a `raw: false` pass, `rawValue` the same cell
 * from a `raw: true` pass. The formatted text wins unless it is exponential.
 *
 * ON AN UNTRUSTED CELL WE STILL EMIT THE EXPANDED NUMBER. Both candidates are
 * wrong — the text has 6 correct digits, the expansion has 15 of 17 — and the
 * expansion at least keeps the right length, so a downstream LEN() check can
 * still spot a malformed identifier. What makes that acceptable rather than
 * "plausible-looking wrong data" is the flag: the caller raises it in the
 * preview, where someone can re-export the column as Text and upload again.
 * Silently emitting either one without the flag would not be acceptable.
 */
export function cellText(formatted: unknown, rawValue: unknown): CellText {
  const text = formatted === null || formatted === undefined ? "" : String(formatted)

  if (!EXPONENTIAL.test(text)) return { text, repaired: false, untrusted: false }

  // Exponential text with no number behind it: nothing better to offer, so the
  // text stands. Happens when the second pass has no cell at that key at all.
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return { text, repaired: false, untrusted: false }
  }

  return { text: plainNumber(rawValue), repaired: true, untrusted: !isTrustworthy(rawValue) }
}
