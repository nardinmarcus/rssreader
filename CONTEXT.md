# Namoo Reader

Namoo Reader is a personal RSS reading and creation workspace. This file is the project glossary: shared names for product concepts, not implementation notes.

## Information Sources

**Built-in Source**:
A publication deliberately curated as part of Namoo Reader's shared source catalog, with a stable identity across deployments. An administrator may still enable or disable it for the current workspace.
_Avoid_: bundled feed, default subscription, hard-coded source

**Custom Source**:
A publication subscribed by an administrator for the current workspace without making it part of Namoo Reader's shared curation.
_Avoid_: built-in source, temporary feed

## Progressive Web App

**Installable Shell**:
The minimal set of static client assets and web app metadata that lets a user add Namoo Reader to the home screen and open it as a standalone window.
_Avoid_: native app, packaged app, offline app

**Offline Shell**:
The Installable Shell when it can still paint the application chrome without a network. It does not include article lists, bodies, sessions, or AI outputs.
_Avoid_: offline mode, offline reading, full offline app

**Online Content Contract**:
The rule that all reading, personal workspace, moderation, and AI work require a live network. When offline, the Offline shell may open, but content surfaces must refuse to pretend data is available.
_Avoid_: stale feed, offline cache of entries, cached API responses

**Shell Update Prompt**:
An explicit user confirmation before a new Installable Shell replaces the one currently controlling the page.
_Avoid_: silent force refresh, automatic skipWaiting without consent

## Annotations

**Highlight Annotation**:
A reader's note or discussion thread anchored to a selected passage of an article asset (original, creation draft, or translation). 划线点评.
_Avoid_: comment on article, margin note without anchor

**Annotation Margin Rail**:
The absolutely positioned overlay beside article content that shows Highlight Annotation cards aligned with their passages. It renders only when the agent panel is open or the view is immersive and the reader pane is wide enough; when the agent panel is collapsed the rail never renders and the content column centers in the widened reader instead.
_Avoid_: sidebar, comment panel, right panel
