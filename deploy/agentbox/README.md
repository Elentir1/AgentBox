# AlpenData AgentBox deployment

This directory is the operator control plane for the one-AgentBox-per-customer
model. It renders a versioned tenant manifest into one isolated Docker Compose
project; it is not a shared request router or a shared data plane.

## Requirements

- Linux host or VM dedicated to one customer
- encrypted host volume mounted under `/var/lib/agentbox/<tenant-id>`
- Docker Engine with Compose v2
- HTTPS identity-aware reverse proxy
- OpenSSL, Node.js 22.19 or newer, and curl
- isolated RAGFlow dataset and API key
- OAuth credentials for selected cloud sources

The example values are placeholders. Do not commit rendered `.env` files,
`runtime.env`, OAuth tokens, customer email addresses, or live manifests.

## Render

```bash
node deploy/agentbox/render-tenant.mjs \
  deploy/agentbox/examples/acme.yaml \
  /var/lib/agentbox/acme/deployment
```

The renderer writes:

- `.env`: non-secret Compose settings
- `deployment.json`: resolved operator paths
- `docker-compose.override.yml`: tenant volumes and secret environment
- `openclaw.batch.json`: validated post-onboarding configuration operations
- `runtime.env.example`: names of required secrets, without values

The renderer rejects a root host directory, a host root that does not contain
the tenant id, a RAGFlow dataset that is not scoped to the tenant id, insecure
WebDAV, credential-bearing URLs, invalid environment-variable names, duplicate
source IDs, trusted-proxy mode without proxy allowlisting, and public HTTP
origins. A private HTTP RAGFlow endpoint requires the explicit
`allowPrivateNetwork: true` acknowledgement.

## Provision

```bash
deploy/agentbox/provision-tenant.sh \
  deploy/agentbox/examples/acme.yaml \
  /var/lib/agentbox/acme/deployment
```

On first run, the command creates
`/var/lib/agentbox/acme/secrets/runtime.env`, generates a Gateway token without
printing it, and stops before starting containers because external credentials
are empty. Fill every value, then rerun the same command.

Provisioning is idempotent: it runs non-interactive onboarding, applies focused
config operations, runs doctor, starts the Gateway, and waits for liveness and
readiness.

## Trusted proxy roles

The reverse proxy is part of the security boundary. It must:

1. authenticate the employee through the customer's identity provider;
2. overwrite, rather than forward, the configured user header;
3. overwrite `x-openclaw-scopes` from a server-side group mapping;
4. connect from an address listed in `gateway.trustedProxies`;
5. prevent direct access to the Gateway port.

Recommended scope mappings:

```text
employee: operator.read,operator.write
admin:    operator.read,operator.write,operator.admin
```

AgentBox requires the scope header for trusted-proxy deployments. The Gateway
intersects it with requested Control UI scopes.

## Back up

```bash
deploy/agentbox/backup-tenant.sh /var/lib/agentbox/acme/deployment
```

The command uses `openclaw backup create --verify`, writes into the tenant backup
volume, and removes only matching archives older than the configured retention.
Store a second encrypted copy outside the customer host.

## Restore

Restoration is destructive and requires the exact tenant ID:

```bash
deploy/agentbox/restore-tenant.sh \
  /var/lib/agentbox/acme/deployment \
  /var/lib/agentbox/acme/backups/<archive>.tar.gz \
  --confirm acme
```

The wrapper verifies the archive with the OpenClaw verifier before stopping the
Gateway. The restore helper accepts only manifest-declared state, workspace,
credentials, and config assets. If copying fails, it restores the previous
directories before restarting the Gateway.

## Offboard and delete

Create and export a final verified backup first. Then remove containers and all
tenant-local state:

```bash
deploy/agentbox/destroy-tenant.sh \
  /var/lib/agentbox/acme/deployment \
  --confirm acme
```

The deletion helper refuses filesystem roots and paths that do not contain the
confirmed tenant ID. Object-storage backups, RAGFlow data, OAuth grants, DNS,
and identity-provider assignments have separate owners and must also be removed.

## Source behavior

- Microsoft 365 uses Graph drive delta links and treats `410 Gone` as a full
  reconciliation.
- Google Drive lists the initial corpus before storing a changes token.
- WebDAV uses HTTPS, guarded same-origin requests, `Depth: 1`, and a complete
  snapshot comparison.
- Local sources are mounted read-only and filtered to supported business
  document extensions.

All users authorized to one AgentBox share its corpus in this MVP. Use separate
deployments for document groups requiring different access. Per-document source
ACL synchronization is not implemented. Search still drops retrieval chunks
whose document IDs were not indexed by this AgentBox, and administrators can
inspect that activity through `agentbox.audit`.

## Required proof

Mocks cannot validate real OAuth consent, tenant permissions, throttling,
provider-specific WebDAV behavior, RAGFlow parsing, or scanned-document OCR.
Before a customer launch, run the corpus and isolation checklist in the
[AgentBox product documentation](../../docs/agentbox/index.md) with real,
non-production customer fixtures.
