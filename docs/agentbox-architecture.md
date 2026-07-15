# Architecture AgentBox

## Objectif

AgentBox doit séparer clairement la valeur produit AlpenData du runtime OpenClaw. Le runtime exécute les agents ; AgentBox gère les clients, les politiques, le déploiement, la supervision et le catalogue.

## Composants cibles

### Control plane AgentBox

Responsabilités :

- organisations et utilisateurs ;
- catalogue et versions d’agents ;
- provisionnement des instances ;
- politiques de permissions ;
- validations humaines ;
- inventaire des connecteurs ;
- consommation, coûts et quotas ;
- santé des déploiements ;
- audit et rapports.

Le control plane ne doit pas stocker les secrets clients en clair et ne doit pas exécuter directement les outils métiers.

### Runtime par client

Chaque PME dispose initialement de son propre environnement d’exécution :

- instance OpenClaw dédiée ;
- workspace dédié ;
- identité système dédiée ;
- secrets et tokens dédiés ;
- base ou stockage dédié ;
- journaux dédiés ;
- restrictions réseau propres au client.

### Catalogue d’agents

Un agent est un package versionné, testable et déployable indépendamment.

```text
agents/<agent-id>/
├── agent.yaml
├── README.md
├── prompts/
├── skills/
├── policies/
├── connectors/
├── evals/
├── fixtures/
└── CHANGELOG.md
```

### Adaptateur de runtime

Le control plane doit appeler une interface stable plutôt que les APIs internes d’OpenClaw.

```ts
export interface AgentRuntime {
  provision(definition: AgentDefinition): Promise<RuntimeInstance>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  execute(instanceId: string, input: AgentInput): Promise<AgentResult>;
  health(instanceId: string): Promise<HealthStatus>;
  usage(instanceId: string): Promise<UsageMetrics>;
  destroy(instanceId: string): Promise<void>;
}
```

Cette abstraction permet de faire évoluer ou remplacer le runtime sans reconstruire tout le produit.

## Flux principal

```text
Client
  │
  ▼
Portail AgentBox
  │
  ├── configuration et approbations
  ├── consultation des journaux
  └── activation d'un agent
          │
          ▼
Control plane AlpenData
          │
          ├── applique les politiques
          ├── provisionne l'instance
          └── transmet une configuration signée
                  │
                  ▼
Runtime isolé du client
          │
          ├── modèle IA
          ├── connecteurs autorisés
          ├── skills autorisés
          └── journaux et métriques
```

## Limites de confiance

Les éléments suivants doivent être considérés comme non fiables :

- messages entrants ;
- pièces jointes ;
- pages web ;
- résultats de recherche ;
- documents clients ;
- sorties de modèles ;
- paramètres fournis par un agent ;
- contenus provenant d’intégrations tierces.

Les actions irréversibles ou externes passent par une politique explicite et, lorsque nécessaire, une approbation humaine.

## Décisions initiales

- Une instance par client avant tout vrai multi-tenant.
- Pas de secret partagé entre entreprises.
- Pas de modification profonde du runtime sans justification documentée.
- Les agents métiers et politiques restent la propriété de la couche AgentBox.
- Les mises à jour upstream passent par une branche et une validation dédiées.
