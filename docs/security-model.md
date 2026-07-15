# AgentBox security model

AgentBox is designed for managed business use. The default posture is deny-by-default, tenant isolation and explicit human approval for sensitive actions.

## Core principles

1. **One trust boundary per customer**
   - Separate runtime instance, container or VM per customer in the initial product phase.
   - Separate state directory, secrets, logs and connector identities.
   - No shared customer credentials.

2. **Least privilege**
   - Each agent receives only the tools and scopes required for its declared use case.
   - Read access and write access are separate capabilities.
   - Administrative permissions require an explicit business justification.

3. **Human approval for consequential actions**
   - Sending external messages, deleting data, changing access, executing payments or modifying production systems must be approval-gated by default.

4. **Auditable execution**
   - Record the initiating user, agent, tool, action, target, result, timestamp and approval decision.
   - Logs must avoid storing secrets and unnecessary personal data.

5. **Untrusted input handling**
   - Emails, documents, web pages and chat messages are untrusted content.
   - Retrieved content must never silently modify system instructions or security policies.

6. **Controlled outbound access**
   - Restrict runtime egress to approved providers and customer services.
   - Block access to infrastructure metadata endpoints and internal networks unless explicitly required.

## Minimum production controls

- Encrypted transport and storage.
- Secret manager instead of plaintext environment files in repositories.
- Dependency and container vulnerability scanning.
- GitHub secret scanning and push protection.
- Signed and versioned releases.
- Backups with tested restoration procedures.
- Per-customer retention and deletion policy.
- Incident response procedure with customer notification workflow.

## Deployment phases

### Pilot

- One isolated deployment per customer.
- Small approved tool catalogue.
- Mandatory approval for write operations.
- Manual AlpenData onboarding and review.

### Managed platform

- Automated provisioning.
- Central control plane without shared runtime state.
- Policy engine, usage metering, health monitoring and immutable audit exports.

### Multi-tenant optimization

Multi-tenant runtime consolidation is allowed only after isolation tests, threat modelling and external security review demonstrate that customer boundaries remain enforceable.

## Responsibility boundary

OpenClaw provides the underlying runtime capabilities. AlpenData remains responsible for the AgentBox configuration, deployment architecture, customer isolation, connector permissions, monitoring and support.