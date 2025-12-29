## ADDED Requirements
### Requirement: Reveal Active File in Finder
The extension MUST provide a "Reveal in Finder" action in the Explorer view title bar that reveals the active file in macOS Finder.

#### Scenario: Active file is a regular file on macOS
- **WHEN** the user triggers "Reveal in Finder" from the Explorer view title bar
- **THEN** Finder opens with the active file selected

#### Scenario: No active file
- **WHEN** the user triggers "Reveal in Finder" with no active file
- **THEN** the extension shows a clear message indicating there is no file to reveal

#### Scenario: Non-macOS platform
- **WHEN** the user attempts to use "Reveal in Finder" on a non-macOS platform
- **THEN** the action is unavailable or a clear message explains the limitation
