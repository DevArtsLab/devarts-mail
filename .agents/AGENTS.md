# Agent Guide

devarts-mail - DevArts Lab project.

## Foundation

This repository is governed by the DevArts Lab foundation: `../foundation`
(remote: `DevArtsLab/foundation`). Adopted revision: 3a (2026-10-26).

## Conventions

- Skills resolve by name from `$AGENT_CONFIG_HOME/skills/`; do not vendor
  copies unless a project ADR opts in (LAB-ADR-0002).
- Project-scope config and skills live in `.agents/`; this file is the
  ordered entry point. The root `AGENTS.md` only points here.
- Track work in the DevArts Lab Linear workspace.

## Ordered Actions

1. Read this file before editing.
2. Check `git status` before and after work; report dirty or unpushed state.
3. Run `git diff --check` for every change.
4. Record decisions in `docs/adr/` and releases in `CHANGELOG.md`.
