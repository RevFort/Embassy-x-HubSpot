/**
 * Turns a raw agency payload into a normalized enquiry with matchable identifiers.
 * Keys are matched case-insensitively because the agency payload mixes styles
 * ("Project_interested", "LeadSource", "utm_ssc").
 */

export interface NormalizedPhone {
  /** Stored form, e.g. +916600110066 */
  e164: string;
  /** Stable key used for batch grouping, locking and caching, e.g. 916600110066 */
  key: string;
  /** Forms the number may already be stored in, used for HubSpot search. */
  variants: string[];
}

export interface Enquiry {
  /** Original payload, untouched. */
  raw: Record<string, unknown>;
  /** Lower-cased key -> trimmed string value, blanks removed. */
  fields: Record<string, string>;
  /** Resolved digits-only calling code used to parse mobile/alternateMobile (payload value, or the default). */
  countryCode: string;
  mobile?: NormalizedPhone;
  alternateMobile?: NormalizedPhone;
  email?: string;
  alternateEmail?: string;
  /** All identifier keys (p:<phone>, e:<email>), used to serialize concurrent processing for the same person. */
  identityKeys: string[];
  warnings: string[];
}

export class ValidationError extends Error {
  readonly errorcode = 'VALIDATION_ERROR';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valid ITU-T E.164 country calling codes. Shared-prefix numbering plans (NANP, UK Crown
 * dependencies) are listed as `<calling code>-<area/zone code>`, e.g. `1-242` (Bahamas), `44-1624`
 * (Isle of Man); only the part before the hyphen is a country code for our purposes.
 */
export const VALID_COUNTRY_CODES = [
  '1',
  '1-242', '1-246', '1-264', '1-268', '1-284', '1-340', '1-345', '1-441', '1-473', '1-649', '1-664',
  '1-670', '1-671', '1-684', '1-758', '1-767', '1-784', '1-787', '1-939', '1-809', '1-829', '1-868',
  '1-869', '1-876',
  '20',
  '212', '213', '216', '218',
  '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233',
  '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '248',
  '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '27',
  '290', '291',
  '297', '298', '299',
  '30', '31', '32', '33', '34',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '36',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '379',
  '380', '381', '382', '385', '386', '387', '389',
  '39',
  '40', '41',
  '420', '421', '423',
  '43', '44',
  '44-1534', '44-1624',
  '45', '46', '47', '48', '49',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '590', '591', '592', '593', '595', '597', '598', '599',
  '60', '61', '62', '63', '64', '65', '66',
  '670', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686',
  '687', '688', '689', '690', '691', '692',
  '7',
  '81', '82', '84',
  '850', '852', '853', '855', '856',
  '86',
  '870', '880', '886',
  '90', '91', '92', '93', '94', '95',
  '960', '961', '962', '963', '964', '965', '966', '967', '968',
  '971', '972', '973', '974', '975', '976', '977',
  '98',
  '992', '993', '994', '995', '996', '998',
];

const VALID_COUNTRY_CODE_PREFIXES = new Set(VALID_COUNTRY_CODES.map((c) => c.split('-')[0]));

export function normalizePhone(raw: string, countryCode: string): NormalizedPhone | undefined {
  const hadPlus = raw.trim().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  const cc = countryCode.replace(/\D/g, '');
  if (!digits) return undefined;

  let national: string;
  if (cc && digits.startsWith(cc) && (hadPlus || digits.length > 10)) {
    national = digits.slice(cc.length);
  } else if (hadPlus) {
    // International number with a different country code than the one supplied; keep as-is.
    return digits.length >= 6
      ? { e164: `+${digits}`, key: digits, variants: [digits, `+${digits}`] }
      : undefined;
  } else {
    national = digits;
  }
  national = national.replace(/^0+/, '');
  if (national.length < 6) return undefined;
  digits = `${cc}${national}`;

  const variants = new Set([national, `0${national}`, digits, `+${digits}`, `+${cc} ${national}`, `${cc} ${national}`]);
  return { e164: `+${digits}`, key: digits, variants: [...variants] };
}

function normalizeEmail(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v && EMAIL_RE.test(v) ? v : undefined;
}

/**
 * Falls back to the default (and warns) if the payload's countrycode isn't a recognized calling code.
 * Always returns digits only (no `+`), matching HubSpot's `country_code__c` dropdown options.
 */
function resolveCountryCode(raw: string | undefined, defaultCountryCode: string, warnings: string[]): string {
  const fallback = defaultCountryCode.replace(/\D/g, '');
  if (!raw) return fallback;
  const digits = raw.replace(/\D/g, '');
  if (VALID_COUNTRY_CODE_PREFIXES.has(digits)) return digits;
  warnings.push(`Ignored invalid countrycode: "${raw}"; using default ${fallback}`);
  return fallback;
}

function toStringValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function parseEnquiry(input: unknown, defaultCountryCode: string): Enquiry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Each lead must be a JSON object');
  }
  const raw = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const s = toStringValue(v);
    if (s !== undefined) fields[k.toLowerCase()] = s;
  }

  const warnings: string[] = [];
  const cc = resolveCountryCode(fields.countrycode, defaultCountryCode, warnings);
  // Normalize in place so the field mapping (country_code__c is a HubSpot dropdown of bare digits) never sees "+91".
  if (fields.countrycode) fields.countrycode = cc;
  const phone = (key: string, ...aliases: string[]) => {
    const value = [key, ...aliases].map((k) => fields[k]).find(Boolean);
    if (!value) return undefined;
    const p = normalizePhone(value, cc);
    if (!p) warnings.push(`Ignored invalid ${key}: "${value}"`);
    return p;
  };
  const email = (key: string, ...aliases: string[]) => {
    const value = [key, ...aliases].map((k) => fields[k]).find(Boolean);
    if (!value) return undefined;
    const e = normalizeEmail(value);
    if (!e) warnings.push(`Ignored invalid ${key}: "${value}"`);
    return e;
  };

  const enquiry: Enquiry = {
    raw,
    fields,
    countryCode: cc,
    mobile: phone('mobile'),
    alternateMobile: phone('alternatemobile', 'alternate_mobile'),
    email: email('email'),
    alternateEmail: email('alternateemail', 'alternate_email'),
    identityKeys: [],
    warnings,
  };

  const phones = [enquiry.mobile, enquiry.alternateMobile];
  const emails = [enquiry.email, enquiry.alternateEmail];
  enquiry.identityKeys = [
    ...new Set([
      ...phones.filter((p): p is NormalizedPhone => !!p).map((p) => `p:${p.key}`),
      ...emails.filter((e): e is string => !!e).map((e) => `e:${e}`),
    ]),
  ].sort();

  if (enquiry.identityKeys.length === 0) {
    throw new ValidationError('A valid mobile or email is required');
  }
  if (!fields.lastname && !fields.firstname) {
    throw new ValidationError('firstname or lastname is required');
  }
  return enquiry;
}
