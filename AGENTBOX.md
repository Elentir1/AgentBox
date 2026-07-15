# AgentBox product boundaries

This repository contains the AgentBox product foundation and an embedded OpenClaw-derived runtime.

## Product rule

AgentBox is the managed product. OpenClaw is the runtime engine.

Customer-facing functionality belongs in AgentBox-specific layers whenever possible. Deep runtime changes are a last resort.

## Where changes belong

| Change | Preferred location |
|---|---|
| SME workflow or business logic | `agents/` |
| Customer policy and permissions | Agent definition or policy layer |
| AlpenData branding | AgentBox portal and documentation |
| Customer provisioning | AgentBox control plane |
| Runtime integration | Adapter or plugin |
| Generic OpenClaw bug fix | Contribute upstream |
| Unavoidable runtime divergence | Isolated patch with tests and rationale |

## Non-goals

AgentBox is not intended to become:

- a generic consumer assistant;
- a cosmetic rename of OpenClaw;
- a shared, weakly isolated multi-customer host;
- a catalogue of untested prompts;
- a system that performs sensitive actions without explicit policy controls.

## Definition of a sellable agent

An agent is not production-ready until it has:

- a narrow business outcome;
- a versioned definition;
- explicit permissions;
- a documented data flow;
- approval rules;
- tenant isolation;
- audit logging;
- measurable success criteria;
- automated evaluations;
- an operational owner and support procedure.

## Upstream maintenance

The runtime must retain an `upstream` relationship with the original OpenClaw project. AgentBox-specific changes should remain small and reviewable so security and reliability updates can be integrated regularly.
