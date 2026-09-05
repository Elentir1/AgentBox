---
summary: "AgentBox subscription tiers, enforced quotas, and the billing lifecycle"
read_when:
  - Quoting or changing an AgentBox subscription
  - Setting spec.subscription in a tenant manifest
  - Deciding what happens to a tenant after a missed payment
title: "AgentBox subscription"
---

# AgentBox subscription

AgentBox is sold as a managed subscription: one isolated deployment per customer,
billed at a fixed monthly tier. There is no usage-based billing and no self-serve
checkout. An AlpenData operator opens the subscription after a demo, and the tier
is what provisions the tenant.

<Warning>
Every figure on this page is a proposal that AlpenData must confirm before it is
quoted to a customer. The **quota names and their enforcement behaviour** are
implemented; the **prices, tier names, and durations** are commercial inputs.
</Warning>

## Tiers

|                                | Starter | Business | Enterprise           |
| ------------------------------ | ------- | -------- | -------------------- |
| Monthly price (CHF, excl. VAT) | 490     | 990      | from 1'900, on quote |
| One-time setup                 | 2'500   | 3'500    | on quote             |
| Document sources               | 1       | 3        | 10                   |
| Indexed documents              | 5'000   | 25'000   | 50'000               |
| Indexed storage                | 10 GB   | 50 GB    | 200 GB               |
| Fastest sync interval          | 60 min  | 15 min   | 5 min                |
| Seats (contractual)            | 25      | 100      | unlimited            |
| Backup retention               | 30 days | 90 days  | 365 days             |

Setup covers the dedicated VM, the isolated RAGFlow, the identity-aware proxy, the
Entra or Google consent flow, and the corpus checklist in
[AgentBox](/agentbox/index). None of it is automated in this version.

## What the quota names mean

Four quotas are technical limits the tenant runtime enforces on itself. They map
one-to-one to `spec.subscription.quotas` in the tenant manifest and to the
`entitlements` block of the `agentbox` plugin configuration.

- `maxSources` — number of configured document sources. Checked when the
  configuration loads: an over-quota tenant refuses to start rather than syncing
  a source the customer has not bought.
- `maxDocuments` — documents indexed for this AgentBox, all sources combined.
  The runtime document index is capped at 50'000 entries per deployment
  (`AGENTBOX_STATE_MAX_ENTRIES` in `extensions/agentbox/src/state.ts`), so no tier
  may promise more. A larger corpus needs a second AgentBox, which is also what the
  isolation model wants when two document groups differ.
- `maxStorageBytes` — total size of those documents.
- `minSyncIntervalMinutes` — floor on `sync.intervalMinutes`. A faster interval is
  a configuration error, not a silent clamp.

`maxDocuments` and `maxStorageBytes` are enforced during synchronization. When a
pass would cross the limit, the source stops at the limit and moves to `error`
with an operator-visible message, exactly like an expired credential. Documents
already indexed are never deleted to make room: over-quota is a commercial event,
not a data-loss event.

### Seats are contractual, not enforced

The seat count is a contract term. AgentBox cannot enforce it: employees are
authenticated by the customer's identity provider through the trusted proxy, and
this version keeps no user registry. Do not present seats as a technical control.
Removing an employee's access is done in the identity provider, and the corpus is
still shared by everyone the proxy admits — see the access-control limitation in
[AgentBox](/agentbox/index).

## Billing lifecycle

The subscription state and the deployment state are separate. The subscription is
the commercial record; `spec.subscription.status` is what the tenant runtime acts
on. An operator or the control plane moves a tenant between states explicitly.

| State       | Deployment      | Customer sees                         |
| ----------- | --------------- | ------------------------------------- |
| `active`    | running         | nothing                               |
| `grace`     | running         | a payment banner in Company documents |
| `suspended` | Gateway stopped | the service is unavailable            |

- **Grace** lasts 14 days from the failed invoice. Everything keeps working.
- **Suspension** stops the Gateway. Data, documents, and backups are kept, and
  backups keep running. Paying reverses it with no data loss.
- **Deletion** happens no earlier than 60 days after suspension, only after a
  final verified backup has been exported to the customer, and only through
  `destroy-tenant.sh` with an explicit operator confirmation. It is irreversible.

`spec.subscription.validUntil` is informational: it is shown to operators and in
the Control UI, and it never disables a tenant on its own. A clock-driven shutdown
would take a paying customer offline whenever the control plane failed to renew
the manifest, so state changes are always pushed explicitly.

If the runtime finds itself running with `status: suspended`, that is a control
plane failure and it is reported as a security-audit finding.

## Changing tier

An upgrade or downgrade re-renders the tenant manifest and applies the new
`entitlements` through `openclaw config set --batch-file`. There is no
re-onboarding and no downtime. A downgrade below what the customer already has
indexed does not delete documents: the sources move to `error` until the corpus
fits, which is the operator's cue to talk to the customer.

## Before quoting

The commercial readiness gate in [AgentBox](/agentbox/index) still applies. In
addition, a price cannot be published before the Swiss VAT treatment, the terms
of service, the data-processing agreement, and the subprocessor list are in place.
