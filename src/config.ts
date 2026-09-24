import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, fallback: number): number => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const targetSchema = z.object({
  property: z.string().min(1),
  onUpdate: z.enum(['overwrite', 'fillEmpty', 'skip']).default('fillEmpty'),
  type: z.enum(['string', 'textarea', 'date', 'number']).default('string'),
});

const mappingSchema = z.object({
  fields: z.array(
    z.object({
      source: z.string().min(1).transform((s) => s.toLowerCase()),
      targets: z.array(targetSchema).min(1),
    }),
  ),
});

export type FieldMapping = z.infer<typeof mappingSchema>;
export type MappingTarget = z.infer<typeof targetSchema>;

export function loadFieldMapping(path: string): FieldMapping {
  return mappingSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: int(env.PORT, 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    oauth: {
      /** Credentials the agency exchanges for an access token. */
      clientId: env.OAUTH_CLIENT_ID ?? '',
      clientSecret: env.OAUTH_CLIENT_SECRET ?? '',
      /** HMAC key that signs access tokens. Changing it invalidates every issued token. */
      signingSecret: env.TOKEN_SIGNING_SECRET ?? '',
      tokenTtlSeconds: int(env.ACCESS_TOKEN_TTL_SECONDS, 3600),
    },
    hubspot: {
      accessToken: env.HUBSPOT_ACCESS_TOKEN ?? '',
      baseUrl: env.HUBSPOT_BASE_URL ?? 'https://api.hubapi.com',
      timeoutMs: int(env.HUBSPOT_TIMEOUT_MS, 15000),
      maxRetries: int(env.HUBSPOT_MAX_RETRIES, 4),
    },

    /** Contact properties that hold identifiers. Searched for matches and written on create. */
    identity: {
      mobile: env.PROP_MOBILE ?? 'phone',
      alternateMobile: env.PROP_ALTERNATE_MOBILE ?? 'mobilephone',
      email: env.PROP_EMAIL ?? 'email',
      alternateEmail: env.PROP_ALTERNATE_EMAIL ?? 'alternate_email',
    },
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE ?? '91',

    campaign: {
      enabled: bool(env.CAMPAIGN_ENABLED, false),
      /** Custom object mirroring Salesforce Campaigns, e.g. p244692974_sf_campaigns. */
      objectType: env.CAMPAIGN_OBJECT_TYPE ?? '',
      /** Property on that object holding the Salesforce campaign ID (payload campaignId). */
      idProperty: env.CAMPAIGN_ID_PROPERTY ?? 'sf_campaign_id',
      /** Custom object mirroring Salesforce Campaign Members, e.g. p244692974_campaign_member. */
      memberObjectType: env.CAMPAIGN_MEMBER_OBJECT_TYPE ?? '',
      memberNameProperty: env.CAMPAIGN_MEMBER_NAME_PROPERTY ?? 'name',
      memberStatusProperty: env.CAMPAIGN_MEMBER_STATUS_PROPERTY ?? 'status',
      memberStatusValue: env.CAMPAIGN_MEMBER_STATUS_VALUE ?? 'Responded',
    },

    createTaskOnReEnquiry: bool(env.CREATE_TASK_ON_RE_ENQUIRY, true),

    integrationLog: {
      dir: env.INTEGRATION_LOG_DIR ?? './logs',
      includePayload: bool(env.INTEGRATION_LOG_INCLUDE_PAYLOAD, true),
    },

    fieldMappingPath: env.FIELD_MAPPING_PATH ?? './config/field-mapping.json',
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
