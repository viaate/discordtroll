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

## The 12 Modes

| #  | Name              | Behavior                                                                 |
| -- | ----------------- | ------------------------------------------------------------------------ |
| 1  | `SelfDenial`      | Indignantly insists it's a human named Craig.                            |
| 2  | `DebateBro`       | Replies with a formal 3-contention debate rebuttal and demands sources.  |
| 3  | `SlowMo`          | Reveals a confusing sentence one word at a time (2.5s edits).            |
| 4  | `PhantomTyper`    | Fakes the typing indicator for 2 minutes, then sends `.` / `k`.          |
| 5  | `TypoGaslight`    | "Corrects" a typo the target never made.                                 |
| 6  | `ReactSpam`       | Reacts with 5 random obscure emojis, no text.                            |
| 7  | `LoadingBar`      | ASCII progress bar that stalls at 99% then errors out.                   |
| 8  | `DelayedGotcha`   | Ignores them, then replies 30–60 minutes later.                          |
| 9  | `AggressiveSponsor` | Every 4th message pivots into a sponsored ad read with a promo code.   |
| 10 | `HostageDelivery` | Holds their food order hostage behind a riddle (uses a collector).       |
| 11 | `InvertedEcho`    | Swaps words for antonyms to "correct" their opinion.                     |
| 12 | `WordSpammer`     | Repeats a word every 3s, hard-capped at 15 messages. Optional `[word]`.  |

## Notes & Safety

- All long-running loops (`SlowMo`, `PhantomTyper`, `LoadingBar`, `WordSpammer`)
  check liveness between steps, so `!stop` cancels them mid-run.
- `WordSpammer` is hard-capped at **15** messages to avoid token bans, then
  auto-disengages.
- State is **in-memory only** — restarting the bot clears all active modes.
- For entertainment among consenting friends. Don't use it to harass people.
