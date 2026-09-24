# Embassy Marketing Lead API (Agency → HubSpot)

A wrapper API that the marketing agency (Aurum) calls instead of HubSpot directly. Embassy hosts it on Azure.
It implements the **Lead Duplicate Identification and Handling SOP**: every incoming enquiry is matched against HubSpot
before anything is written, so HubSpot keeps one Contact per customer and no campaign/UTM attribution is lost.
The agency's "lead" is a HubSpot **Contact**. The service doesn't use HubSpot's Lead object.

## Authentication (OAuth 2.0 client credentials)

Get an access token, then send it as a bearer token. This is the same flow the agency uses with Salesforce today.

```bash
curl -X POST https://<host>/oauth2/token \
  -d grant_type=client_credentials -d client_id=<id> -d client_secret=<secret>
```
```json
{ "access_token": "eyJzdWIi...", "token_type": "Bearer", "expires_in": 3600, "issued_at": "1788420221997" }
```

- The body can be form-encoded or JSON. Credentials can also be sent as HTTP Basic auth.
- Errors: `400 unsupported_grant_type`, `401 invalid_client`.
- Tokens expire after `ACCESS_TOKEN_TTL_SECONDS` (default 3600). When the token expires (a `401` from the leads endpoint), request a new one.
- Tokens are HMAC-signed and stateless, so they survive restarts. Rotating `TOKEN_SIGNING_SECRET` revokes every token.
  Changing `OAUTH_CLIENT_ID` also revokes all tokens. Changing only `OAUTH_CLIENT_SECRET` blocks new tokens, but tokens already issued keep working until they expire.

## Endpoint

`POST /api/v1/leads` with header `Authorization: Bearer <access_token>`. The body is a single lead object.

```json
{
  "firstname": "Test", "lastname": "aurum", "mobile": "6600110066", "email": "testaurum@aa.in",
  "countrycode": "+91", "Project_interested": "Embassy South Reserve", "LeadSource": "Digital Marketing",
  "modeofenquiry": "Web", "subsource": "Social Media", "owner": "LMT Queue", "Medium": "Webzaa", "Term": "",
  "comments": "Comfortable with Budget: yes", "campaignId": "701fv00000MD4xKAAT",
  "enquiryDate": "2026-05-12", "utm_ssc": "Facebook"
}
```

Also accepted as identifiers: `alternatemobile`, `alternateemail`. Keys are case-insensitive.

### Response (SOP §5)

| Scenario | `responseId` | `status` | `action` |
|---|---|---|---|
| Existing contact found | existing Contact ID | 200 | `EXISTING_CONTACT_UPDATED` |
| No duplicate | new Contact ID | 200 | `NEW_CONTACT_CREATED` |
| Error | error message | 400 | `errorcode`: `VALIDATION_ERROR`, `MOBILE_ALREADY_EXISTS`, `HUBSPOT_ERROR`, `INTERNAL_ERROR` |

One object in → one object out. The HTTP status equals `status`.

## How the SOP maps to HubSpot

| SOP step | Salesforce | This service |
|---|---|---|
| 2–4. Duplicate check | Person Account / Residential Lead, create then delete the duplicate | Search Contacts on every phone property. If one matches, it is updated and a follow-up Task is created for its owner. Nothing new is created |
| 5. UTM/Campaign attribution | Campaign Member / Task | Campaign Member custom-object record associated to the SF-campaign record and the Contact, plus the Task above |
| 6. New enquiry | New Lead | New Contact with every mapped field |
| 9. Errors | Integration_Logs__c | JSONL file per day in `INTEGRATION_LOG_DIR` (one line per lead, with the payload) plus stdout |

**Matching fields:** mobile, alternate mobile only. Email is never used to find a matching contact (only stored on
the contact once one is found or created). Each incoming phone is compared against both phone properties. Phones are
normalized, so `6600110066`, `+916600110066`, `+91 66001 10066` and `06600110066` all match. New numbers are stored as `+916600110066`.
If several contacts match, the one matched on the incoming mobile wins, then the most recently modified.

**Update rules** (see `config/field-mapping.json`): on an existing contact, `fillEmpty` fields are only written if blank. This keeps
the original UTM/source attribution. `overwrite` fields (e.g. `latest_project_interested`, `latest_enquiry_date`) always take the latest value.
Every enquiry's full details go into the re-enquiry Task and the integration log.
A new phone/email on an existing Contact goes into the empty primary or alternate slot.
The service never sets the contact owner. The payload's `owner` value is only stored in `requested_owner_queue`, and the re-enquiry Task goes to the contact's current owner.

**Failure isolation:** if a campaign member or Task can't be created, the request still returns 200 and the problem is recorded in the integration log.
Only failures that stop the Contact being created or updated return 400.

## Concurrency and HubSpot search lag

HubSpot's search index takes a few seconds to catch up after a write. Without handling this, two quick calls for the same person would both create a contact. The service:
1. serializes processing per phone/email with an in-process lock, and
2. on contact create, catches a unique-email 409 and re-runs the flow against the existing contact.

Creates are never retried after timeouts or 5xx errors (only after 429), because a retry could create a duplicate.

> **Run a single instance.** The lock is in-memory. To scale out, move it to Redis or an Azure Blob lease first.

## Setup

```bash
cp .env.example .env            # fill HUBSPOT_ACCESS_TOKEN, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, TOKEN_SIGNING_SECRET
npm ci
npm run setup:properties        # dry run: lists custom properties that are missing
npm run setup:properties -- --apply
npm run dev                     # or: npm run build && npm start
npm test
```

The service assumes the configured properties already exist in the portal and writes to them directly; run
`setup:properties` first (or create them yourself) so leads aren't rejected by HubSpot for an unknown property.

### Campaign attribution

Set `CAMPAIGN_ENABLED=true`, `CAMPAIGN_OBJECT_TYPE` (the custom object mirroring SF Campaigns, e.g. `p<portalId>_sf_campaigns`),
`CAMPAIGN_ID_PROPERTY` (the property holding the SF campaign ID), and `CAMPAIGN_MEMBER_OBJECT_TYPE`. The member → campaign / contact
associations must be defined in HubSpot, because the service uses default associations.

### Deploy (Azure)

```bash
docker build -t marketing-lead-api .
```
Run it on Azure Container Apps or App Service (container), with the env vars from `.env.example` as app settings (HubSpot token, OAuth client secrets and signing secret in Key Vault).
Mount persistent storage at `/app/logs` if the integration log files must survive restarts. Limit ingress to the agency's IPs.

## Out of scope

HubSpot → Meta stage/remark events (retargeting) use the API Aurum will provide. That is a separate HubSpot workflow webhook, not part of this service.
