# Project instructions — quran reel

## Model routing

Consult the `model-router` skill at the start of each task to pick the appropriate free model + variant. Default for this project: DeepSeek V4.1 Flash Free (variant high).

Task-type → model mapping:
- architecture / multi-file refactor / hard bug → Beam Free #high (or #max if blocking)
- daily coding / vibecoding / iteration → DeepSeek V4.1 Flash Free #high
- simple / boilerplate / trivial edits → DeepSeek V4.1 Flash Free #low (or MiMo-V2.6-Flash)
- vision / UI / screenshot review → Nemotron 3.5 Super VL Free #high
- premium reasoning (free via Gemini key) → Gemini 4 Hydrogen #high
- balanced (free via Gemini key) → Gemini 3.8 Flash #high
- cheap high-volume (free via Gemini key) → Gemini Flash-Lite Latest #high
- thinking mode (free via Gemini key) → Gemma 4 26B A4B IT #thinking
- deep research → Deep Research Max Preview
- fine-grained control → Inkling 2 Small Free #high
- fallback → Big Pickle / Iceman Free / LongCat 2.5 Free

Helper: `.\select-model.ps1 -TaskType <type> [-Copy]`

Note: OpenCode's root `model` field sets a single default and does not retain a `#variant`. Per-task variant selection is done by passing `model` to subagents or by switching the session model.

## Specialized agents
- `@architect` (Beam Free#high) — architecture, refactor, debug dur
- `@fast-coder` (DeepSeek#low) — code rapide, boilerplate
- `@vision-reviewer` (Nemotron#high) — UI, screenshots, multimodal
- `@premium` (Gemini 4 Hydrogen#high) — raisonnement premium
- `@researcher` (Deep Research Max) — recherche approfondie
- `@thinker` (Gemma 4 26B#thinking) — mode thinking gratuit

## Contexte du projet
Ce projet a été codé en grande partie avec Big Pickle (modèle ancien, sans contrôle du raisonnement). Le code peut contenir des bugs, des failles de sécurité et un manque de tests. Voir REFACTOR_PROMPT.md pour le plan d'audit et de refactor.
