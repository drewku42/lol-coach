---
name: install
description: Install and set up lol-coach from this repository - the Claude Code plugin, the Riot API key and the local web app. Use when the user asks to install, set up, get started with, or fix the setup of lol-coach while working in this repo.
---

# Install lol-coach

Work through these in order and stop at the first failure. Run commands from the repository root.

**Never ask for the Riot API key in chat and never write it to a file yourself.** The user enters
it in their own terminal (step 3).

## 1. Check prerequisites

```bash
node --version
```

Needs Node 18 or newer. There is nothing to `npm install`: the project has no dependencies.

```bash
npm test
```

All tests should pass. They use fake data and need no key or network.

## 2. Install the plugin into Claude Code

```bash
claude plugin validate .
```

```bash
claude plugin marketplace add ./
```

```bash
claude plugin install lol-coach@lol-coach-marketplace
```

If the marketplace is already added, skip to the install. The plugin's tools and `/lol-coach:*`
commands appear after the user restarts Claude Code or runs `/reload-plugins`. To try the plugin
without installing it, start Claude Code with `claude --plugin-dir .` instead.

## 3. Riot API key and player (the user does this)

Ask the user to:

1. Sign in at https://developer.riotgames.com and copy their key (starts with `RGAPI-`). A
   development key lasts 24 hours; a Personal API Key, requested on the same site under
   "Register Product", does not expire.
2. Run this **in their own terminal**, not through you, and answer its three prompts (key, Riot ID
   as `GameName#TAG`, server such as `na1`):

```bash
npm run setup
```

It saves to `~/.config/lol-coach/config.json`, which both the plugin and the web app read. When
only the key has expired, the user runs `npm run setup -- --key`.

## 4. Verify

```bash
npm run check
```

It prints whether a key is configured and accepted and who the default player is, without showing
the key. `apiKeyValid: false` with a 401 or 403 means the key is wrong or expired: back to step 3.
`No Riot account found` means the Riot ID or server is wrong.

## 5. Start the web app

```bash
npm run app
```

Run it in the background and tell the user to open http://localhost:4173. The dashboard, game
reviews and plan work straight away. The **Coach** chat panel additionally needs Claude Code
installed and logged in on the same machine.

## Finish

Tell the user what is installed, the app URL, and three things to try: set a rank goal on the
dashboard, click a game to open its review, and ask `/lol-coach:coach what should I work on?` in
Claude Code. Mention that a development key must be replaced every 24 hours.
