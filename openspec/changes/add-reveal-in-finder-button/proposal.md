# Change: Add "Reveal in Finder" Button

## Why
Users want a dedicated Explorer title bar button to quickly reveal the active file in macOS Finder, without using the context menu.

## What Changes
- Add a "Reveal in Finder" button in the Explorer view title bar.
- Wire the button to a command that reveals the active file in Finder.
- **BREAKING** None.

## Impact
- Affected specs: reveal-in-finder
- Affected code: VS Code extension command and Explorer view title menu contribution
