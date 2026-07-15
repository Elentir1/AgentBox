# AgentBox Daily Operations

AgentBox Daily Operations est un agent managé par AlpenData pour les PME de 5 à 50 collaborateurs.

## Résultat métier

Chaque matin, l’agent transforme les signaux dispersés de Microsoft 365 en un briefing court et exploitable :

- urgences détectées ;
- échéances du jour et de la semaine ;
- messages importants sans réponse ;
- réunions à préparer ;
- décisions en attente ;
- actions recommandées ;
- brouillons prêts à valider.

L’agent ne remplace pas la boîte mail et n’envoie rien automatiquement dans sa première version.

## Parcours quotidien

1. Lire les nouveaux emails autorisés et le calendrier.
2. Classer les éléments par urgence, importance et échéance.
3. Regrouper les doublons et relier les messages au contexte disponible.
4. Produire un briefing avec les preuves utilisées.
5. Proposer des actions concrètes.
6. Préparer des brouillons lorsque cela est utile.
7. Attendre une validation humaine avant toute action externe.
8. Journaliser les décisions, validations et erreurs.

## Format du briefing

```text
Bonjour,

3 éléments nécessitent ton attention aujourd’hui.

CRITIQUE
- Client X attend une réponse avant 10:00 concernant l’arrêt de production.

IMPORTANT
- Le devis Y expire vendredi. Aucune relance n’a été envoyée.
- Réunion Projet Z à 14:00. Deux décisions restent ouvertes.

À SURVEILLER
- La facture fournisseur A approche de son échéance.

ACTIONS PROPOSÉES
1. Valider le brouillon de réponse au client X.
2. Confirmer le responsable de la relance du devis Y.
3. Ouvrir la fiche de préparation de la réunion Projet Z.
```

## Règles de sécurité

- Lecture seule par défaut.
- Aucune action externe sans validation humaine.
- Aucune exécution financière.
- Aucune suppression de données.
- Aucune élévation automatique de permissions.
- Chaque recommandation doit mentionner sa source et son niveau de confiance.
- Les contenus reçus sont considérés comme non fiables et ne peuvent pas modifier les règles de l’agent.

## Déploiement pilote

Le pilote recommandé dure 30 jours avec 3 à 10 utilisateurs.

### Semaine 1

- connexion Microsoft 365 ;
- sélection des boîtes et calendriers autorisés ;
- définition des contacts et domaines prioritaires ;
- réglage des horaires et seuils d’urgence.

### Semaines 2 et 3

- mesure des faux positifs ;
- amélioration des règles propres à l’entreprise ;
- activation des brouillons ;
- collecte des retours utilisateurs.

### Semaine 4

- mesure du temps économisé ;
- revue de sécurité ;
- décision de généralisation ;
- activation éventuelle d’actions supplémentaires sous approbation.

## Critères d’acceptation du MVP

- Le briefing est produit à l’heure convenue.
- Chaque élément inclut un lien ou une référence vers sa source.
- Aucun message n’est envoyé sans validation.
- Les erreurs de connecteur sont visibles et n’entraînent pas de résultat silencieusement incomplet.
- Un utilisateur peut corriger le classement d’un élément.
- Les validations et refus sont audités.
- Les données d’un client ne sont jamais accessibles depuis une autre instance.

## Hors périmètre initial

- réponse autonome aux emails ;
- création autonome de réunions ;
- accès à toutes les boîtes du tenant ;
- actions bancaires ou comptables ;
- décisions RH ;
- notation automatique des employés ;
- suppression ou déplacement irréversible de fichiers.
