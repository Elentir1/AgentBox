---
summary: "AlpenData AgentBox architecture, onboarding, document sources, and security model"
read_when:
  - Provisioning or reviewing an AlpenData AgentBox tenant
  - Changing AgentBox document sources, RAGFlow, or employee identity
  - Diagnosing empty Company knowledge or citation failures
title: "AlpenData AgentBox"
---

# AlpenData AgentBox

AlpenData AgentBox is a managed document assistant for Swiss small and
medium-sized businesses. Each customer receives one isolated OpenClaw runtime,
document dataset, secret set, backup policy, and public origin. This page
describes that operator-provisioned product. It is not a self-serve portal and
it does not show demo tenants or invented citations.

The customer-facing product is AgentBox. The `openclaw` CLI, package names,
configuration paths, environment variables, Gateway protocol, and plugin SDK
remain internal technical identifiers for compatibility with the upstream
ecosystem.

The Control UI follows the [AlpenData](https://www.alpendata.ch) visual
system: Inter, light-first slate surfaces, navy contrast sections, and the
official red mountain mark with `#dc2626` accents. Published product links are
limited to pages that exist today, currently
[Contact](https://www.alpendata.ch/contact). Do not ship unpublished
`/agentbox/docs` or `/privacy` URLs as if they were live.

## Isolation model

One customer maps to one host or virtual machine and one Compose project.
AgentBox does not place mutually untrusted customers inside one Gateway.

Each deployment has separate:

- Gateway and RAGFlow network boundaries
- SQLite state and agent databases
- document source credentials
- RAGFlow dataset
- workspace and document mounts
- backups and retention policy

This follows the Gateway's [personal trust boundary](/gateway/security). Session
keys and UI navigation are not tenant isolation controls.

## Onboarding

An AlpenData operator starts from `deploy/agentbox/examples/tenant.template.yaml`.
Replace every `<angle-bracket>` value. The `spec.image` field is the tag produced
by the AgentBox image pipeline; the template does not publish an image.

1. Record the company name, public HTTPS origin, deployment root, and model.
2. Set `identity.mode: trusted-proxy` for employee tenants. Token mode is
   AlpenData operator access only and must be chosen explicitly.
3. Add at least one document source and the matching secret **names**.
4. Render the tenant deployment and fill `runtime.env` with real values.
5. Provision the Gateway and wait for both liveness and readiness.
6. Open **Company documents** and confirm live `agentbox.status`. Empty sources,
   RAGFlow errors, and expired credentials are visible states, not an all-green
   checklist.
7. Ask a known-answer question against the real corpus and verify that
   citations come from `agentbox_search`.
8. Invite employees through the identity provider.

The generated setup uses non-interactive OpenClaw onboarding. Customers do not
need the CLI, Gateway token, plugin settings, or JSON configuration.

## Roles

The identity-aware reverse proxy must set `x-openclaw-scopes` from server-side
identity-provider policy. Never copy a scope value supplied by the browser.

- Employees receive `operator.read,operator.write`. AgentBox shows chat,
  conversation history, and company documents.
- Customer and AlpenData administrators additionally receive `operator.admin`.
  AgentBox shows the complete operator console.

The Gateway intersects the trusted proxy's declared scopes with the scopes
requested by Control UI. The `shellProfile: auto` setting uses the resulting
`operator.admin` scope to select the interface, while Gateway method
authorization remains the enforcement boundary.

Unauthenticated employees see a company-identity retry, not `openclaw dashboard`
instructions.

## Document sources

v1 connectors are Microsoft 365, Google Drive, and Infomaniak kDrive. Local
folders remain an optional adapter; they are not a marketed v1 source.
Generic Nextcloud is out of scope unless the same HTTPS WebDAV adapter applies.

Credentials live in the tenant secret store (`runtime.env`). Manifests list
environment variable **names** only.

- **Microsoft 365:** AlpenData Entra app plus customer admin consent. The plugin
  mints an app token with client-credentials against
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` and Graph
  `/.default`. It refreshes before expiry and retries once on 401. A failed
  refresh fails closed. Do not store a disposable Graph access token.
- **Google Drive:** one-time operator OAuth (Workspace admin or service account
  with domain-wide delegation) using Drive read-only scopes
  (`drive.readonly` / `drive.metadata.readonly` for shared drives). Persist
  client id, client secret, and refresh token. The plugin refreshes on 401.
  Do not reuse Gemini CLI scopes.
- **Infomaniak kDrive:** HTTPS WebDAV at
  `https://<id>.connect.kdrive.infomaniak.com` with a username and app password.
  No kDrive OAuth in this phase.

A dead credential sets the source to `error` with an operator-visible message.
AgentBox will not scan with a token it cannot renew.

All sources normalize into the same lifecycle:

`discover -> compare -> download -> upload -> parse -> index -> delete`

RAGFlow is deployed per customer and stays **outside** the AgentBox Compose
project. The plugin uploads source files, attaches tenant and provenance
metadata, starts parsing, and exposes citation-ready retrieval through
`agentbox_search`. If RAGFlow is down, the dataset is not tenant-scoped, or a
private HTTP URL is used without `allowPrivateNetwork`, `agentbox.status` and
Company knowledge show an error. Zero documents is not "everything is fine".

## Chat and citations

The tenant workspace `AGENTS.md` is written at provision. The assistant must
call `agentbox_search` before citing internal documents. If the tool returns no
authorized match, it must say so. Invented SharePoint, Drive, or kDrive sources
are a product defect.

## Access-control limitation

This version authorizes one document corpus as a group. Every employee allowed
by the trusted proxy can search every document indexed for that AgentBox. The
Company knowledge page states that limitation.

Search still fails closed at the instance boundary. Retrieval is limited to
the tenant's RAGFlow dataset, then filtered to document IDs this AgentBox has
indexed. Chunks from another customer are dropped and recorded in the audit
log.

Source-level or per-document ACL synchronization is not an enforcement
boundary. If two employee groups must not see the same documents, provision
separate AgentBox deployments.

## Audit

Each AgentBox keeps a 90-day SQLite audit trail of document searches and
synchronization runs. Search entries store the actor, a SHA-256 query digest,
a short query preview, authorized document IDs, and the number of dropped
foreign chunks. Administrators can read the trail through `agentbox.audit`.
The trail does not store document bodies or source credentials.

## Operations that live outside this repository

The repo cannot be production by itself. Before a paying tenant, AlpenData must
own these operator jobs. Do not simulate them in the Control UI.

- Build and push the AgentBox container image. The manifest `image` field is an
  input, not a published default tag.
- Provision a dedicated VM, encrypted volume, Compose stack, and TLS at the
  customer origin.
- Run an isolated RAGFlow whose dataset id is `{tenantId}` or `{tenantId}-…`.
- Place an IdP reverse proxy (Entra or Google) in front of the Gateway. The
  proxy authenticates the employee, **overwrites** the user header and
  `x-openclaw-scopes`, and blocks direct Gateway access.
- Register AlpenData Entra and Google Cloud apps, then collect customer admin
  consent. Mint the kDrive app password at Infomaniak.
- Store the model API key (`OPENAI_API_KEY` or equivalent) in the tenant secret
  file.
- Keep an off-host encrypted backup and run a restore drill.
- Complete FADP / LPD review, MIT OpenClaw notices, and AlpenData legal pages
  before calling the product generally available.

See the repository runbook at `deploy/agentbox/README.md`.

## Commercial readiness gate

Before onboarding a paying customer, AlpenData must complete a pilot with that
customer's actual APIs and representative data. UI fixtures are not that
proof.

- OAuth consent and token renewal for Google and Microsoft
- WebDAV behavior for the selected kDrive tenant
- native Office files, text PDFs, scanned PDFs, and large files
- rename, update, deletion, permission removal, and cursor reset, including
  Graph `410 Gone`
- negative cross-customer and unauthorized-user tests
- backup, restore, key rotation, upgrade, export, and deletion
- legal review of the MIT notices, product trademark, privacy terms, and Swiss
  FADP or applicable GDPR obligations

Contract tests cover source adapters, token retry, tenant-scoped rendering,
restore and deletion safeguards, citation formatting, known-answer fixture
retrieval, and cross-tenant document-id filtering. They do not replace live
OAuth consent, provider quotas, RAGFlow OCR, or production isolation drills.
