# AlpenData AgentBox deployment

This directory is the operator control plane for the one-AgentBox-per-customer
model. It renders a versioned tenant manifest into one isolated Docker Compose
project; it is not a shared request router or a shared data plane.

Employee Control UI never presents demo companies, fake document counts, or
CLI login instructions. Those belong to engineering fixtures, not the product.

## Requirements

These are operator jobs. The renderer records them; it does not perform them.

- Linux host or VM dedicated to one customer
- encrypted host volume mounted under `/var/lib/agentbox/<tenant-id>`
- Docker Engine with Compose v2
- HTTPS identity-aware reverse proxy that overwrites user and scope headers
- OpenSSL, Node.js 22.19 or newer, and curl
- isolated RAGFlow dataset and API key, outside this Compose project
- AlpenData Entra app + customer admin consent for Microsoft 365
- AlpenData Google Cloud OAuth client + operator refresh token for Drive
- Infomaniak kDrive app password
- model API key
- off-host encrypted backup target

Start from `deploy/agentbox/examples/tenant.template.yaml`. Replace every
`<angle-bracket>` value. `spec.image` is the tag from the real build pipeline.
Do not treat a sample `ghcr.io/...` tag as a published image. Do not commit
rendered `.env` files, `runtime.env`, OAuth tokens, customer email addresses,
or live manifests.

## Render

```bash
node deploy/agentbox/render-tenant.mjs \
  deploy/agentbox/examples/tenant.template.yaml \
  /var/lib/agentbox/<tenant-id>/deployment
```

The renderer writes:

- `.env`: non-secret Compose settings
- `deployment.json`: resolved operator paths
- `docker-compose.override.yml`: tenant volumes and secret environment
- `openclaw.batch.json`: validated post-onboarding configuration operations
- `runtime.env.example`: names of required secrets, without values
- `workspace/AGENTS.md`: citation contract for the company assistant

The renderer requires `spec.identity.mode`. Employee tenants use
`trusted-proxy`. Token mode is AlpenData operator access only.

The renderer rejects a root host directory, a host root that does not contain
the tenant id, a RAGFlow dataset that is not scoped to the tenant id, insecure
WebDAV, credential-bearing URLs, invalid environment-variable names, duplicate
source IDs, trusted-proxy mode without proxy allowlisting, public HTTP
origins, and disposable `accessTokenEnv` source credentials. A private HTTP
RAGFlow endpoint requires the explicit `allowPrivateNetwork: true`
acknowledgement.

`openclaw doctor --fix` reports leftover `accessTokenEnv` keys. It cannot mint
Entra or Google client credentials; fill the canonical secret names instead.

## Provision

```bash
deploy/agentbox/provision-tenant.sh \
  deploy/agentbox/examples/tenant.template.yaml \
  /var/lib/agentbox/<tenant-id>/deployment
```

On first run, the command creates
`/var/lib/agentbox/<tenant-id>/secrets/runtime.env`, generates a Gateway token
without printing it, copies the workspace citation instructions, and stops
before starting containers because external credentials are empty. Fill every
value, then rerun the same command.

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
intersects it with requested Control UI scopes. `shellProfile: auto` then
selects the employee or administrator shell. Token-mode operator boxes keep
`shellProfile: full` so AlpenData staff still see CLI login help.

## Back up

```bash
deploy/agentbox/backup-tenant.sh /var/lib/agentbox/<tenant-id>/deployment
```

The command uses `openclaw backup create --verify`, writes into the tenant backup
volume, and removes only matching archives older than the configured retention.
Store a second encrypted copy outside the customer host and run a restore drill
before calling the tenant production-ready.

## Restore

Restoration is destructive and requires the exact tenant ID:

```bash
deploy/agentbox/restore-tenant.sh \
  /var/lib/agentbox/<tenant-id>/deployment \
  /var/lib/agentbox/<tenant-id>/backups/<archive>.tar.gz \
  --confirm <tenant-id>
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
  /var/lib/agentbox/<tenant-id>/deployment \
  --confirm <tenant-id>
```

The deletion helper refuses filesystem roots and paths that do not contain the
confirmed tenant ID. Object-storage backups, RAGFlow data, OAuth grants, DNS,
and identity-provider assignments have separate owners and must also be removed.

## Source behavior

- Microsoft 365 uses Graph client-credentials, drive delta links, and treats
  `410 Gone` as a full reconciliation. 401 after a failed refresh is a source
  error.
- Google Drive lists the initial corpus before storing a changes token, then
  refreshes the operator token on 401.
- kDrive WebDAV uses HTTPS, guarded same-origin requests, `Depth: 1`, a
  username/app-password, and a complete snapshot comparison.
- Local sources, when used, are mounted read-only and filtered to supported
  business document extensions.

All users authorized to one AgentBox share its corpus in this version. Use
separate deployments for document groups requiring different access.
Per-document source ACL synchronization is not implemented. Search still drops
retrieval chunks whose document IDs were not indexed by this AgentBox, and
administrators can inspect that activity through `agentbox.audit`.

## Required proof

Mocks cannot validate real OAuth consent, tenant permissions, throttling,
provider-specific WebDAV behavior, RAGFlow parsing, or scanned-document OCR.
Before a customer launch, run the corpus and isolation checklist in the
[AgentBox product documentation](../../docs/agentbox/index.md) with real,
non-production customer fixtures.
