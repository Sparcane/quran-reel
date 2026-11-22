# Prompt d'audit et de refactor — projet "quran reel"

Collez ce prompt dans la conversation du projet pour lancer l'analyse.

---

Tu travailles sur le projet "quran reel", codé en grande partie avec le modèle Big Pickle (ancien, sans contrôle du raisonnement). Ce modèle a pu laisser du code fragile, des bugs, des failles de sécurité et un manque de tests.

## Objectif
Analyser le codebase, identifier les zones à risque, et proposer un plan de refactor priorisé pour améliorer la qualité, la sécurité et la maintenabilité — sans tout réécrire d'un coup.

## Étapes à suivre

1. **Cartographie** — Lance `/graphify .` pour générer le graphe de connaissances du codebase (graph.html, GRAPH_REPORT.md, graph.json). Identifie les "god nodes" (modules centraux) et les communautés.

2. **Audit de qualité** — Lance `/code-review-and-quality` sur les modules critiques (auth, données, API, logique métier). Cherche : bugs de logique, gestion d'erreurs manquante, code dupliqué, abstractions inutiles, variables mal nommées.

3. **Audit de sécurité** — Lance `/security-and-hardening` et `/security-audit`. Vérifie : validation des entrées, authentification, exposition de secrets, dépendances vulnérables, CORS, injection.

4. **Analyse des tests** — Lance `/test-driven-development` pour identifier les modules sans tests. Priorise la logique métier (parsing, calculs, transformations) et les chemins critiques (auth, paiements).

5. **Rapport de synthèse** — Produis un rapport structuré :
   - **Zones critiques** (à refactorer en priorité) avec justification
   - **Zones acceptables** (peuvent rester telles quelles)
   - **Plan de refactor par étapes** (petits lots, testables, réversibles)
   - **Risques** si on ne fait rien

6. **Modèle à utiliser** — Ce projet a été codé avec Big Pickle (peu fiable). Pour le refactor, utilise les modèles appropriés :
   - Architecture / refactor multi-fichiers / debug dur → **Beam Free** (variant `high` ou `max`)
   - Code rapide / boilerplate / tests → **DeepSeek V4.1 Flash Free** (variant `high` ou `low`)
   - Review UI / screenshots → **Nemotron 3.5 Super VL Free** (variant `high`)
   - Problème bloquant → **Gemini 4 Hydrogen** (variant `high`, gratuit via clé API)
   - Mode thinking gratuit → **Gemma 4 26B** (variant `thinking`)

   Invoque les agents spécialisés : `@architect` pour l'architecture, `@fast-coder` pour le code rapide, `@premium` pour les problèmes bloquants, `@vision-reviewer` pour l'UI.

## Contraintes
- Ne réécris pas tout d'un coup. Propose des lots petits et réversibles.
- Chaque lot doit inclure des tests avant modification.
- Ne coupe jamais la validation, la gestion d'erreurs, la sécurité ou l'accessibilité.
- Termine par un résumé de ce qui a été fait, ce qui reste, et les risques connus.

## Livrable attendu
Un plan de refactor priorisé avec :
1. Liste des modules à risque (avec score de criticité)
2. Ordre d'intervention recommandé
3. Estimation de l'effort par module
4. Commandes à lancer pour chaque étape

Commence par l'étape 1 (cartographie) et demande confirmation avant de passer à la suite.
