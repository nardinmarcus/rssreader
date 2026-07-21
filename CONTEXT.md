# Namoo Reader

Namoo Reader is a personal RSS reading and creation workspace. This file is the project glossary: shared names for product concepts, not implementation notes.

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
