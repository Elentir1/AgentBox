# AgentBox by AlpenData

**Des agents numériques managés pour les PME suisses.**

AgentBox transforme un runtime d’agents IA puissant en une offre exploitable par des entreprises : agents préconfigurés, permissions maîtrisées, déploiement isolé, supervision, traçabilité et accompagnement AlpenData.

> **Statut : fondation technique / préversion.** Ce dépôt n’est pas encore une offre SaaS multi-tenant prête pour la production. Les déploiements clients doivent rester isolés et supervisés.

## Vision

Les PME ne devraient pas devoir assembler elles-mêmes des modèles, des prompts, des connecteurs et une infrastructure d’agents.

AgentBox vise une expérience simple :

1. choisir un agent métier ;
2. connecter les outils autorisés ;
3. définir les validations humaines ;
4. déployer dans un environnement isolé ;
5. mesurer les actions, les coûts et la valeur produite.

## Positionnement

AgentBox n’est pas un chatbot générique. C’est une plateforme d’agents numériques gérés par AlpenData pour des cas d’usage concrets :

- veille et synthèse opérationnelle ;
- préparation de rendez-vous et de dossiers ;
- triage documentaire et informationnel ;
- assistance aux processus internes ;
- surveillance d’événements et alertes ;
- orchestration d’actions avec validation humaine ;
- assistants spécialisés par métier ou par entreprise.

## Principes produit

- **Simple pour le client** : aucune administration de runtime ou de fichiers YAML.
- **Sécurisé par défaut** : permissions minimales, secrets séparés et actions sensibles approuvées.
- **Isolé par entreprise** : pas de mélange de données, d’identités ou de sessions entre clients.
- **Traçable** : journalisation des actions, des décisions, des coûts et des erreurs.
- **Réversible** : données exportables, agents désactivables et intégrations remplaçables.
- **Runtime interchangeable** : la valeur AgentBox doit rester dans le produit, les agents et la gouvernance, pas dans un fork profond.

## Architecture cible

```text
AgentBox
├── Portail client
├── Console AlpenData
├── Catalogue d’agents
├── Moteur de politiques et d’approbations
├── Provisionnement et cycle de vie
├── Gestion des secrets et identités
├── Observabilité, audit et coûts
├── Connecteurs métiers
└── Runtime d’agents OpenClaw
```

Voir :

- [Architecture AgentBox](docs/agentbox-architecture.md)
- [Socle de sécurité](docs/security-baseline.md)
- [Stratégie de suivi OpenClaw](docs/upstream-strategy.md)
- [Manifeste d’un agent AgentBox](docs/agent-manifest.md)

## Déploiement recommandé

Pour les premiers clients, le modèle supporté est **une instance isolée par entreprise** :

- conteneur ou machine dédiée ;
- identité système distincte ;
- coffre de secrets séparé ;
- stockage séparé ;
- règles réseau restrictives ;
- politiques et journaux propres au client.

Une simple séparation logique par workspace ne doit pas être considérée comme une isolation multi-tenant suffisante.

## Structure du produit

Le runtime présent dans ce dépôt reste volontairement proche d’OpenClaw. Les éléments différenciants doivent être développés sous forme de couches séparées :

```text
agentbox/
├── agents/          # Agents métiers versionnés
├── integrations/    # Connecteurs AlpenData et clients
├── policies/        # Permissions et approbations
├── deployment/      # Profils de déploiement isolés
├── docs/            # Architecture et exploitation
└── runtime/         # Adaptation minimale du moteur
```

## Règles de développement

Avant toute modification du cœur du runtime, vérifier si le besoin peut être traité par :

1. configuration ;
2. agent ou skill ;
3. connecteur externe ;
4. couche AgentBox ;
5. contribution au projet upstream.

Les modifications profondes du runtime sont le dernier recours, car elles augmentent le coût de maintenance et compliquent les mises à jour de sécurité.

## Feuille de route

### Phase 1 — Fondation

- identité AgentBox et documentation ;
- modèle d’agent versionné ;
- déploiement isolé par client ;
- journalisation et politiques minimales ;
- premier agent métier reproductible.

### Phase 2 — Produit managé

- portail de configuration ;
- catalogue d’agents ;
- validations humaines ;
- suivi des coûts et de l’activité ;
- mises à jour contrôlées du runtime.

### Phase 3 — Industrialisation

- provisionnement automatisé ;
- gestion centralisée du parc ;
- évaluations automatiques ;
- sauvegarde et reprise ;
- conformité et rapports clients.

## À propos d’AlpenData

AgentBox est développé et opéré par **AlpenData**, prestataire suisse de services informatiques et d’automatisation IA pour PME.

Site : [alpendata.ch](https://www.alpendata.ch)

## Origine du runtime et licence

AgentBox utilise et adapte **OpenClaw** comme moteur d’agents. OpenClaw est un projet open source distribué sous licence MIT.

- Projet upstream : [openclaw/openclaw](https://github.com/openclaw/openclaw)
- Documentation upstream : [docs.openclaw.ai](https://docs.openclaw.ai)
- Licence : [LICENSE](LICENSE)
- Mentions tierces : [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Les marques, noms et identités visuelles d’OpenClaw restent distincts de la marque AgentBox et d’AlpenData.
