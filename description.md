# Introduction

I want to create an app that will scan all talks for the APS March Meeting 2026 that is happening in Denver and help me organize my schedule. For background, this app is goinng to be used by experts in quantum computing, with different specializations, like theory, experiment, numerical simulation, fabrication, etc.

## Features

- [x] Extract all interesting sessions based on `data/session-preferences.txt` into `json` file.
- [x] Take list of interesting sessions and make a table with monday to friday columns with interesting session for each day. The final table is going to be displayed in confluence page, so think about integration with confluence.
- [] Based on user preference defined in `data/schedule-preferences.txt`, create a personalized schedule with talks and create calendar invites.
- [] Should be able to group by Authors, e.g. google, IQM, IBM, etc.

