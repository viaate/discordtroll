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

| Command                                   | Effect                                              |
| ----------------------------------------- | --------------------------------------------------- |
| `!troll <David\|ID> <ModeName> [args]`    | Activate a mode against a user.                     |
| `!stop <David\|ID>`                        | Clear that user's mode (kills timers).              |
| `!status`                                  | List active trolls + who you're spying/puppeting.   |
| `!spy <David\|ID>`                         | Toggle live mirroring of a victim's DMs (both ways).|
| `!say <David\|ID> <message>`               | Send one message to a user **as the bot**.          |
| `!puppet <David\|ID>`                      | Talk live as the bot — then just type. `!puppet off`.|
| `!help`                                    | Show every command (owner only).                    |

Mode names are case-insensitive. Example:

```
!troll David SlowMo
!troll David WordSpammer banana
!spy David
!stop David
```

### Name aliases

Type a saved name instead of a long user ID. Edit the `USER_ALIASES` map near
the top of `index.js` to add your own:

```js
const USER_ALIASES = new Map([
  ['david', '936763714110107709'],
]);
```

### Spy mode

`!spy David` mirrors everything in David's DM with the bot to **your** DMs, each
line wrapped in a code block so it's easy to read:

```
[David ➜ BOT] this sucks
```
```
[BOT ➜ David] *this rocks
```

Run `!spy David` again to turn it off. (Live message edits — e.g. SlowMo /
LoadingBar — are not mirrored, to avoid flooding your DMs.)

### Talking as the bot

- `!say David hey what's up` — fires off a single message to David as the bot.
- `!puppet David` — enters live puppet mode: from then on, **anything you type
  that isn't a `!command` goes straight to David as the bot**, and their replies
  mirror back to you (spy is auto-enabled). Auto-troll modes are paused for the
  person you're puppeting so the bot never talks over you. `!puppet off` exits.

> The bot can only DM a user it shares a server with (and who allows DMs).

## The Modes

Most text modes are **content-aware** — they parse the target's actual message
and build a customized reply, rather than spitting canned lines. Run `!help` in
a DM for the live list.

| Name              | Behavior                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `SelfDenial`      | Indignant one-liners insisting it's a human named Craig + 😤 react.       |
| `DebateBro`       | Short debate-bro burns ("**Source?** 📚") keyed off a word they used.     |
| `SlowMo`          | Reveals a short confusing sentence **built around one of their words**, 2.5s edits. |
| `PhantomTyper`    | Fakes the typing indicator (2 min), then sends `.` / `k`.                |
| `TypoGaslight`    | **Scans for homophones** (their/there/they're…), rewrites the message with each swap in **bold**. |
| `ReactSpam`       | Reacts to each message with 5 random obscure emojis, no text.            |
| `LoadingBar`      | ASCII progress bar **labeled with their message** that stalls at 99% then errors. |
| `DelayedGotcha`   | Ignores them, then **quotes their message** in a reply 30–60 min later.  |
| `AggressiveSponsor` | Every 4th message **pivots off a word they used** into a one-line sponsor read. |
| `HostageDelivery` | Holds their food order hostage behind a riddle (uses a collector).       |
| `InvertedEcho`    | **Flips words in their message** to antonyms (sucks→rocks, stupid→genius). |
| `WordSpammer`     | Repeats a word every 3s, capped at 15 messages. Optional `[word]`.       |
| `MockingCase`     | Repeats their message back in `mOcKiNg SpOnGeBoB cAsE` 🤡.                 |
| `OneUpper`        | Whatever they did, it did it harder/bigger. Content-aware.               |
| `WrongName`       | Calls them the wrong name forever and ignores corrections.               |
| `Therapist`       | "and how does that make you feel?" Detached-therapist energy.            |
| `Ratio`           | Pure gen-z ragebait: `L + ratio + you fell off` 💀.                       |
| `FakeMod`         | Escalating fake rule warnings → fake ban countdown → "just kidding 😘".   |
| `GhostQuote`      | "Reminds" them of unhinged things they never said.                       |
| `UmActually`      | Insufferable pedant: "well *technically* you're wrong" 🤓.                |
| `AutoRage`        | **Automated gauntlet:** cycles through the other modes one at a time, finishing each before the next, then loops until `!stop`. |

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
