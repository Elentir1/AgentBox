---
summary: "AlpenData AgentBox architecture, onboarding, document sources, and security model"
title: "AlpenData AgentBox"
---

# AlpenData AgentBox

AlpenData AgentBox is a managed document assistant for small and medium-sized
businesses. Each customer receives an isolated OpenClaw runtime, document
dataset, secret set, backup policy, and public origin.

The customer-facing product is AgentBox. The `openclaw` CLI, package names,
configuration paths, environment variables, Gateway protocol, and plugin SDK
remain internal technical identifiers for compatibility with the upstream
ecosystem.

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

An AlpenData operator starts from a versioned tenant manifest:

1. Record the company name, public HTTPS origin, deployment root, and model.
2. Configure trusted-proxy identity or temporary token authentication.
3. Add at least one document source.
4. Render the tenant deployment and fill the generated secret environment file.
5. Provision the Gateway and wait for both liveness and readiness.
6. Open **Company documents** in AgentBox and run the first synchronization.
7. Ask a known-answer question and verify its citations.
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

## Document sources

The bundled AgentBox plugin supports four read-only source families:

- **Google Drive:** initial `files.list`, followed by the Drive changes cursor.
  Google-native files are exported as PDF.
- **Local folders and PDFs:** recursive, read-only mounts. Hidden files,
  symbolic links, executable files, and unsupported extensions are ignored.
- **Microsoft 365:** OneDrive or SharePoint drive delta queries. Items are
  tracked by immutable drive item ID rather than path.
- **Nextcloud and kDrive:** recursive WebDAV `PROPFIND` with ETag-based change
  detection and guarded downloads.

All sources normalize into the same lifecycle:

`discover -> compare -> download -> upload -> parse -> index -> delete`

RAGFlow is deployed per customer. The plugin uploads source files, attaches
tenant and provenance metadata, starts parsing, and exposes citation-ready
retrieval through `agentbox_search`.

## Access-control limitation

The MVP authorizes one document corpus as a group. Every employee allowed by
the trusted proxy can search every document indexed for that AgentBox.

Search still fails closed at the instance boundary. Retrieval is limited to
the tenant's RAGFlow dataset, then filtered to document IDs this AgentBox has
indexed. Chunks from another customer are dropped and recorded in the audit
log.

Source-level or per-document ACL synchronization is not yet an enforcement
boundary. If two employee groups must not see the same documents, provision
separate AgentBox deployments or separate corpora with independently enforced
access. Do not import restricted documents into a shared corpus.

## Audit

Each AgentBox keeps a 90-day SQLite audit trail of document searches and
synchronization runs. Search entries store the actor, a SHA-256 query digest,
a short query preview, authorized document IDs, and the number of dropped
foreign chunks. Administrators can read the trail through `agentbox.audit`.
The trail does not store document bodies or source credentials.

## Operations

The deployment toolkit provides:

- manifest validation and deterministic Compose rendering
- non-interactive provisioning
- `/healthz` and `/readyz` checks
- verified backups with retention
- confirmed restore with rollback on failure
- confirmed tenant destruction for customer offboarding
- tenant-scoped host directories and RAGFlow dataset ids
- document-search audit with foreign-chunk drop counts

Run storage on encrypted volumes, terminate TLS at the customer origin, encrypt
backup storage, and restrict private RAGFlow and WebDAV egress to tenant-owned
hosts. Run `openclaw security audit --deep` after provisioning and every
configuration change.

See the repository runbook at `deploy/agentbox/README.md`.

## Commercial readiness gate

Before onboarding a paying customer, AlpenData must complete a pilot with that
customer's actual APIs and representative data:

- OAuth consent and token renewal for Google and Microsoft
- WebDAV behavior for the selected Nextcloud or kDrive service
- native Office files, text PDFs, scanned PDFs, and large files
- rename, update, deletion, permission removal, and cursor reset
- negative cross-customer and unauthorized-user tests
- backup, restore, key rotation, upgrade, export, and deletion
- legal review of the MIT notices, product trademark, privacy terms, and Swiss
  FADP or applicable GDPR obligations

Contract tests cover source adapters, tenant-scoped rendering, restore and
deletion safeguards, citation formatting, known-answer fixture retrieval, and
cross-tenant document-id filtering. They do not replace live OAuth consent,
provider quotas, RAGFlow OCR, or production isolation drills.
