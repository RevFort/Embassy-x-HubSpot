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
  mobile?: NormalizedPhone;
  alternateMobile?: NormalizedPhone;
  email?: string;
  alternateEmail?: string;
  /** All identifier keys (p:<phone>, e:<email>), used for grouping, locks and the recent-create cache. */
  identityKeys: string[];
  warnings: string[];
}

export class ValidationError extends Error {
  readonly errorcode = 'VALIDATION_ERROR';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Payload keys consumed as identifiers; everything else goes through the field mapping. */
export const IDENTITY_SOURCE_KEYS = new Set([
  'mobile',
  'alternatemobile',
  'alternate_mobile',
  'email',
  'alternateemail',
  'alternate_email',
  'countrycode',
]);

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
  const cc = fields.countrycode ?? defaultCountryCode;
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
