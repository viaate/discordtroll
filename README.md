# Discord Troll Bot

A remote-controlled Discord bot that operates entirely in Direct Messages. You
(the **owner**) DM the bot commands; the bot runs an interactive "troll mode"
against a targeted user, reacting to every DM that user sends it.

> Built with [discord.js](https://discord.js.org) v14 + ES modules. Tested on
> Windows with Node.js 18+.

## Setup (Windows)

```bat
git clone <your-repo-url> discordtroll
cd discordtroll
npm install
copy .env.example .env
```

Then open `.env` and fill in:

| Variable        | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `DISCORD_TOKEN` | Bot token from the [Developer Portal](https://discord.com/developers/applications). |
| `OWNER_ID`      | Your own Discord user ID (Developer Mode → right-click → Copy ID). |

### Required Privileged Intent

In the Developer Portal → your app → **Bot**, enable **MESSAGE CONTENT
INTENT**. Without it the bot can't read DM text.

### Run

```bat
npm start
```

## Owner Commands (DM the bot)

| Command                                       | Effect                                  |
| --------------------------------------------- | --------------------------------------- |
| `!troll <TargetUserID> <ModeName> [args]`     | Activate a mode against a user.         |
| `!stop <TargetUserID>`                         | Clear that user's mode (kills timers).  |
| `!status`                                      | List every active troll.                |

Mode names are case-insensitive. Example:

```
!troll 123456789012345678 SlowMo
!troll 123456789012345678 WordSpammer banana
!stop 123456789012345678
```

> The bot can only DM a user it shares a server with (and who allows DMs).

## The 13 Modes

Most text modes are **content-aware** — they parse the target's actual message
and build a customized reply, rather than spitting canned lines.

| #  | Name              | Behavior                                                                 |
| -- | ----------------- | ------------------------------------------------------------------------ |
| 1  | `SelfDenial`      | Insists it's a human named Craig **and quotes their own words** as "proof". |
| 2  | `DebateBro`       | Formal 3-contention rebuttal whose points **reference a keyword they used**. |
| 3  | `SlowMo`          | Reveals a confusing sentence **built around one of their words**, 2.5s edits. |
| 4  | `PhantomTyper`    | Fakes the typing indicator for 2 minutes, then sends `.` / `k`.          |
| 5  | `TypoGaslight`    | **Scans their message for homophones** (their/there/they're, your/you're, its/it's, then/than, …), rewrites it with each swap in **bold**, hands it back. |
| 6  | `ReactSpam`       | Reacts to each message with 5 random obscure emojis, no text.            |
| 7  | `LoadingBar`      | ASCII progress bar **labeled with their message** that stalls at 99% then errors. |
| 8  | `DelayedGotcha`   | Ignores them, then **quotes their message** in a reply 30–60 minutes later. |
| 9  | `AggressiveSponsor` | Every 4th message **pivots off a word they used** into a sponsored ad read. |
| 10 | `HostageDelivery` | Holds their food order hostage behind a riddle (uses a collector).       |
| 11 | `InvertedEcho`    | **Swaps words in their message** for antonyms to "correct" their opinion. |
| 12 | `WordSpammer`     | Repeats a word every 3s, hard-capped at 15 messages. Optional `[word]`, else their last word. |
| 13 | `AutoRage`        | **Automated gauntlet:** cycles through the other modes one at a time, finishing each before the next, then loops until `!stop`. |

### How content-awareness works

`TypoGaslight` is the clearest example. If the target sends:

```
their going over there with they're dog
```

the bot detects all three homophones, swaps each to a different "correct"
spelling, bolds them, and replies:

```
**they're** going over **their** with **there** dog
*(Fixed that for you.)*
```

Capitalization is preserved (`Their` → `They're`). If a message contains no
homophones, it falls back to gaslighting a real word pulled from that same
message — never a canned line.

`AutoRage` runs everything for you. `!troll <id> AutoRage` kicks off the
gauntlet; each message the target sends advances the current mode, and the bot
strictly runs **one mode at a time**, waiting for long sequences (SlowMo,
LoadingBar, WordSpammer, PhantomTyper) to fully finish before starting the next.
`!status` shows which sub-mode is currently running.

## Slash Command: `/usernamegenerator`

Anyone who shares a server with the bot (or DMs it) can run:

```
/usernamegenerator input:Olivia
```

…and get back 10 "username ideas" that bolt a silly prefix onto their name
(e.g. `Poopy Olivia`, `Stinky Olivia`). It's a harmless novelty command — and a
convenient reason to get people to add the bot. Global slash commands can take
up to an hour to appear the first time after the bot starts.

## Notes & Safety

- All long-running loops (`SlowMo`, `PhantomTyper`, `LoadingBar`, `WordSpammer`)
  check liveness between steps, so `!stop` cancels them mid-run.
- `WordSpammer` is hard-capped at **15** messages to avoid token bans, then
  auto-disengages.
- State is **in-memory only** — restarting the bot clears all active modes.
- For entertainment among consenting friends. Don't use it to harass people.
