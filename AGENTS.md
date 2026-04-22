<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

## Project Structure Preference

Use the current layout as the preferred project structure:

```
.
├─ .agent/      # Local agent resources and reusable skills
├─ src/   # VS Code extension source, build output, and scripts
├─ openspec/    # OpenSpec specs and changes
├─ release/     # Generated .vsix packages
├─ README.md
└─ .gitignore
```

## Skills

For agent-specific workflows and reusable procedures, check the local skills
stored under:

- `@/.agent/-skills/skills/`

When the user asks to publish, release, package, deploy, or run a structured
workflow, consult the relevant skill in that folder before acting.

Do not rely on the user to name the skill explicitly if the matching workflow
already exists there.

Secrets remain local to each skill and must not be committed.
