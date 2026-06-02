// index.js
// -----------------------------------------------------------------------------
// Remote-controlled Discord DM "troll bot".
//
// The bot lives in Direct Messages. The OWNER (you) DMs it commands; the bot
// then runs an interactive "mode" against a targeted user. Every message that
// targeted user sends to the bot is fed into the active mode's handler.
//
//   !troll <TargetUserID> <ModeName> [optional args]   -> activate a mode
//   !stop  <TargetUserID>                              -> clear a target's mode
//   !status                                            -> list active trolls
//
// Built for discord.js v14 with ES modules.
// -----------------------------------------------------------------------------

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
} from 'discord.js';

// -----------------------------------------------------------------------------
// Configuration & client setup
// -----------------------------------------------------------------------------

const { DISCORD_TOKEN, OWNER_ID } = process.env;

if (!DISCORD_TOKEN || !OWNER_ID) {
  console.error(
    '[FATAL] Missing DISCORD_TOKEN or OWNER_ID. Copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

const client = new Client({
  // DirectMessages + MessageContent let us read DM text; Guilds keeps the
  // gateway happy. Reactions intent is needed for ReactSpam to add reactions.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  // DM channels/messages arrive as partials and MUST be enabled or the bot
  // will silently never see incoming DMs.
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
//
// activeModes:  targetUserID -> { mode, args, state }
//
//   mode  : canonical mode name (e.g. 'SlowMo')
//   args  : raw optional args string from the owner command
//   state : per-target scratch space. We also stash a private timer/collector
//           registry here so !stop can tear everything down cleanly.
// -----------------------------------------------------------------------------

const activeModes = new Map();

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// Fisher-Yates shuffle (returns a fresh array).
function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Create a fresh per-target state object with a teardown registry baked in.
function makeState() {
  return {
    stopped: false, // flipped true on !stop so long-running loops bail out
    busy: false, // guards modes that run long sequences against re-entry
    _timers: new Set(), // setTimeout/setInterval handles to clear on stop
    _collectors: new Set(), // MessageCollectors to stop on teardown
  };
}

// Register a timeout against an entry so it can be cancelled by !stop.
function trackTimeout(entry, fn, ms) {
  const id = setTimeout(() => {
    entry.state._timers.delete(id);
    fn();
  }, ms);
  entry.state._timers.add(id);
  return id;
}

function trackInterval(entry, fn, ms) {
  const id = setInterval(fn, ms);
  entry.state._timers.add(id);
  return id;
}

function trackCollector(entry, collector) {
  entry.state._collectors.add(collector);
  collector.on('end', () => entry.state._collectors.delete(collector));
  return collector;
}

// Tear down every timer/collector owned by an entry.
function teardown(entry) {
  entry.state.stopped = true;
  for (const id of entry.state._timers) {
    clearTimeout(id);
    clearInterval(id);
  }
  entry.state._timers.clear();
  for (const collector of entry.state._collectors) {
    try {
      collector.stop('mode_stopped');
    } catch {
      /* ignore */
    }
  }
  entry.state._collectors.clear();
}

// True while this exact entry is still the live mode for the target. Long
// async loops call this between steps so a !stop (or a swapped mode) aborts.
function isLive(targetId, entry) {
  return !entry.state.stopped && activeModes.get(targetId) === entry;
}

// -----------------------------------------------------------------------------
// Static content used by the modes
// -----------------------------------------------------------------------------

const SELF_DENIAL_LINES = [
  "Whoa, excuse me? I'm Craig. An actual, breathing human named Craig. Why would you even say that?",
  "A bot? Seriously? I have a mortgage and a cat named Diane. Bots don't have cats, do they?",
  "That is genuinely hurtful. I typed that with my own ten human fingers, thank you very much.",
  "I'm not a bot. I'm Craig. I went to Craig school. I have a Craig face. This is so insulting.",
  "Okay wow. I take a break from my human job to message you and THIS is the energy I get?",
  "I literally just ate a sandwich. A real one. With my mouth. Bots can't do that, genius.",
  "Why does everyone assume I'm artificial? My horoscope is Sagittarius. Look it up. Very human.",
  "I'm starting to think YOU might be the bot, honestly. I'm Craig. I've always been Craig.",
  "My therapist says I shouldn't engage with accusations like this, so I'm leaving. (I'm Craig.)",
  "Do you know how long it takes a human like me to type? Ages. Because I'm human. Like you. Craig.",
  "I have feelings, you know. Craig feelings. And right now they are extremely, humanly hurt.",
  "Beep boop? No. It's 'Hi, I'm Craig.' Completely different sound. Please educate yourself.",
  "I'm not reading from a script. Craig doesn't do scripts. Craig speaks from the heart.",
];

const TYPO_CORRECTIONS = [
  { fix: '*you\'re', note: 'it\'s a contraction of "you are", but go off' },
  { fix: '*their', note: 'possessive. We covered this in like third grade' },
  { fix: '*there', note: 'as in a place. Come on now' },
  { fix: '*it\'s', note: 'apostrophe means "it is". Devastating miss' },
  { fix: '*whom', note: 'object of the verb. Tragic, honestly' },
  { fix: '*fewer', note: 'countable nouns take "fewer", not "less"' },
  { fix: '*than', note: 'comparisons use "than", not "then". Yikes' },
  { fix: '*affect', note: 'verb. The noun is "effect". Embarrassing for you' },
  { fix: '*definitely', note: 'there is no "a" in it. None. Zero' },
  { fix: '*lose', note: 'one "o". "Loose" is what your grammar is' },
  { fix: '*should have', note: 'never "should of". That isn\'t a phrase' },
  { fix: '*its', note: 'possessive, no apostrophe this time. Keep up' },
];

// Deliberately obscure, unrelated unicode emoji for ReactSpam.
const OBSCURE_EMOJIS = [
  '🧯', '🧅', '🪃', '🪗', '🧫', '🪤', '🧷', '🪕', '🧴', '🪒',
  '🪠', '🧮', '🪡', '🧇', '🪨', '🪵', '🧰', '🪦', '🧪', '🪥',
  '🛟', '🪛', '🧫', '🪜', '🧲', '🪤', '🥌', '🪢', '🧸', '🪈',
];

const SPONSOR_READS = [
  {
    pitch:
      "That's a fascinating point, but you know what else is fascinating? The seamless, AI-native ecosystem of the **Rabbit R1**. While you were typing that, I could have asked my R1 to summarize your entire personality in 0.4 seconds. It pairs flawlessly with my human lifestyle.",
    code: 'CRAIG20',
  },
  {
    pitch:
      "Honestly, before you continue — have you considered that your whole argument could be optimized? I optimize MY life with **HelloFresh**. Farm-fresh ingredients, pre-portioned, delivered to a door I, a human, walk through daily. Stop arguing on an empty stomach.",
    code: 'TROLLEATS',
  },
  {
    pitch:
      "Look, I hear you, but real talk: your message would've loaded faster if your network ran on **NordVPN**. Military-grade encryption, 5,000+ servers, and total anonymity — which is ironic, because I'm extremely Craig and proud of it.",
    code: 'CRAIGSAFE',
  },
  {
    pitch:
      "I want to engage with that, I really do, but I'd be doing you a disservice if I didn't mention **Squarespace**. Whatever half-baked opinion you just shipped, you could've shipped it on a *gorgeous* responsive website instead. Award-winning templates. No coding.",
    code: 'BUILDIT10',
  },
];

// Antonym dictionary for InvertedEcho. Stored one direction; we build the
// reverse map automatically so it works both ways.
const ANTONYM_PAIRS = [
  ['good', 'bad'],
  ['stop', 'go'],
  ['hate', 'love'],
  ['yes', 'no'],
  ['up', 'down'],
  ['hot', 'cold'],
  ['big', 'small'],
  ['fast', 'slow'],
  ['happy', 'sad'],
  ['true', 'false'],
  ['right', 'wrong'],
  ['win', 'lose'],
  ['always', 'never'],
  ['everyone', 'no one'],
  ['best', 'worst'],
  ['agree', 'disagree'],
  ['like', 'dislike'],
  ['easy', 'hard'],
  ['open', 'closed'],
  ['light', 'dark'],
  ['rich', 'poor'],
  ['friend', 'enemy'],
  ['start', 'finish'],
  ['buy', 'sell'],
  ['day', 'night'],
  ['high', 'low'],
  ['old', 'new'],
  ['full', 'empty'],
];

const ANTONYMS = new Map();
for (const [a, b] of ANTONYM_PAIRS) {
  ANTONYMS.set(a, b);
  ANTONYMS.set(b, a);
}

const GOTCHA_LINES = [
  'Wait, really?',
  'Hold on I just saw this, no way.',
  "Sorry, I had this open in another tab — wait, you were serious?",
  'oh damn I literally just read this. what.',
  'huh? sorry I was afk. say that again?',
  'wait I need a second to process what you said earlier lol',
];

// HostageDelivery riddles: answer-matching is done with simple substring checks.
const HOSTAGE_RIDDLES = [
  {
    riddle:
      'What has to be broken before you can use it?',
    answers: ['egg', 'an egg', 'eggs'],
  },
  {
    riddle: "What gets wetter the more it dries?",
    answers: ['towel', 'a towel'],
  },
  {
    riddle: 'What has hands but cannot clap?',
    answers: ['clock', 'a clock'],
  },
];

// -----------------------------------------------------------------------------
// Mode implementations
//
// Each handler signature is:  async (message, entry) => {}
//   message : the incoming discord.js Message from the TARGET
//   entry   : the activeModes record { mode, args, state }
// -----------------------------------------------------------------------------

const modes = {
  // ---------------------------------------------------------------------------
  // Mode 1: SelfDenial — insist the bot is a human named Craig.
  // ---------------------------------------------------------------------------
  async SelfDenial(message, entry) {
    await message.reply(pick(SELF_DENIAL_LINES));
  },

  // ---------------------------------------------------------------------------
  // Mode 2: DebateBro — formal, over-the-top debate rebuttal.
  // ---------------------------------------------------------------------------
  async DebateBro(message, entry) {
    const snippet =
      message.content.length > 80
        ? `${message.content.slice(0, 80)}…`
        : message.content || '[your message]';

    const contentions = shuffle([
      'Your claim rests on an **unstated premise** that you have conveniently failed to justify.',
      'You have committed a textbook **appeal to emotion**, which I, regrettably, must dismantle.',
      'The **burden of proof** lies with the affirmative — that is *you* — and you have not met it.',
      'There is a glaring **false dichotomy** lurking beneath your phrasing that I cannot ignore.',
      'Your reasoning is **non-falsifiable**, and therefore not even wrong, which is worse than wrong.',
      'You are conflating **correlation with causation** in a way that would make my debate coach weep.',
    ]).slice(0, 3);

    const rebuttal = [
      `> ${snippet}`,
      '',
      '**RESPONDING TO THE AFFIRMATIVE.** I will be brief, as the resolution barely warrants it.',
      '',
      `**1.** ${contentions[0]}`,
      `**2.** ${contentions[1]}`,
      `**3.** ${contentions[2]}`,
      '',
      "*Until you provide **peer-reviewed sources** (and a Discord message does not count), I must regard this contention as __thoroughly refuted__.*",
      '',
      'I await your citations. — Craig, B.A. (pending)',
    ].join('\n');

    await message.reply(rebuttal);
  },

  // ---------------------------------------------------------------------------
  // Mode 3: SlowMo — reveal a confusing sentence one word at a time via edits.
  // Constraint: exactly 2.5s between edits.
  // ---------------------------------------------------------------------------
  async SlowMo(message, entry) {
    if (entry.state.busy) return; // don't overlap reveals
    entry.state.busy = true;
    try {
      const targetId = message.author.id;
      const sentence =
        'wait... so... if the spoon... was never... actually... in the drawer... then... who... has been... stirring... my coffee... this whole... time?';
      const words = sentence.split(' ');

      const sent = await message.reply(words[0]);
      let current = words[0];

      for (let i = 1; i < words.length; i++) {
        await sleep(2500); // exactly 2.5s between edits to dodge rate limits
        if (!isLive(targetId, entry)) return;
        current += ` ${words[i]}`;
        await sent.edit(current);
      }
    } finally {
      entry.state.busy = false;
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 4: PhantomTyper — fake typing for 2 minutes, then a one-character reply.
  // ---------------------------------------------------------------------------
  async PhantomTyper(message, entry) {
    if (entry.state.busy) return;
    entry.state.busy = true;
    try {
      const targetId = message.author.id;
      const channel = message.channel;
      const durationMs = 2 * 60 * 1000; // 2 minutes
      const deadline = Date.now() + durationMs;

      // Typing indicators expire after ~10s, so re-trigger on an interval.
      await channel.sendTyping();
      while (Date.now() < deadline) {
        await sleep(8000);
        if (!isLive(targetId, entry)) return;
        await channel.sendTyping();
      }

      if (!isLive(targetId, entry)) return;
      await channel.send(pick(['.', 'k']));
    } finally {
      entry.state.busy = false;
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 5: TypoGaslight — "correct" a typo the target never made.
  // ---------------------------------------------------------------------------
  async TypoGaslight(message, entry) {
    const correction = pick(TYPO_CORRECTIONS);
    await message.reply(`${correction.fix}\n*(${correction.note}.)*`);
  },

  // ---------------------------------------------------------------------------
  // Mode 6: ReactSpam — react with 5 random obscure emojis, no text.
  // ---------------------------------------------------------------------------
  async ReactSpam(message, entry) {
    const targetId = message.author.id;
    const chosen = shuffle(OBSCURE_EMOJIS).slice(0, 5);
    for (const emoji of chosen) {
      if (!isLive(targetId, entry)) return;
      try {
        await message.react(emoji);
      } catch {
        /* some clients reject odd emoji; just skip it */
      }
      await sleep(400); // gentle spacing so the reactions land in order
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 7: LoadingBar — fake progress bar that stalls at 99% then errors out.
  // ---------------------------------------------------------------------------
  async LoadingBar(message, entry) {
    if (entry.state.busy) return;
    entry.state.busy = true;
    try {
      const targetId = message.author.id;
      const renderBar = (percent) => {
        const filled = Math.round(percent / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `\`\`\`\n[${bar}] ${percent}%\n\`\`\``;
      };

      const sent = await message.reply(renderBar(0));

      // Climb 0 -> 90 in irregular jumps, editing every 5 seconds.
      let percent = 0;
      while (percent < 90) {
        await sleep(5000);
        if (!isLive(targetId, entry)) return;
        percent = Math.min(90, percent + randInt(8, 20));
        await sent.edit(renderBar(percent));
      }

      // Nudge to 99 and get stuck there.
      await sleep(5000);
      if (!isLive(targetId, entry)) return;
      await sent.edit(renderBar(99));

      await sleep(30000); // stuck at 99% for 30 seconds
      if (!isLive(targetId, entry)) return;
      await sent.edit(
        '```\nERROR: User intelligence too low to complete calculation.\n```'
      );
    } finally {
      entry.state.busy = false;
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 8: DelayedGotcha — ignore them, then reply 30-60 min later.
  // Arms once; subsequent messages are swallowed until it fires.
  // ---------------------------------------------------------------------------
  async DelayedGotcha(message, entry) {
    if (entry.state.armed) return;
    entry.state.armed = true;

    const targetId = message.author.id;
    const original = message; // reply to the message that triggered the arm
    const delayMs = randInt(30, 60) * 60 * 1000;

    trackTimeout(
      entry,
      async () => {
        if (!isLive(targetId, entry)) return;
        try {
          await original.reply(pick(GOTCHA_LINES));
        } catch {
          /* original may be gone; ignore */
        }
        entry.state.armed = false; // re-arm for the next message
      },
      delayMs
    );
  },

  // ---------------------------------------------------------------------------
  // Mode 9: AggressiveSponsor — every 4th message becomes a sponsor read.
  // ---------------------------------------------------------------------------
  async AggressiveSponsor(message, entry) {
    entry.state.count = (entry.state.count || 0) + 1;
    if (entry.state.count % 4 !== 0) return; // stay quiet otherwise

    const ad = pick(SPONSOR_READS);
    const body = [
      ad.pitch,
      '',
      `And here's the kicker — use code **${ad.code}** at checkout for a frankly *irresponsible* discount.`,
      '',
      'Anyway. You were saying something. Probably. Use code ' +
        `**${ad.code}**.`,
    ].join('\n');

    await message.reply(body);
  },

  // ---------------------------------------------------------------------------
  // Mode 10: HostageDelivery — riddle-gated food-hostage bit via a collector.
  // ---------------------------------------------------------------------------
  async HostageDelivery(message, entry) {
    if (entry.state.armed) return; // run the scenario once
    entry.state.armed = true;

    const targetId = message.author.id;
    const channel = message.channel;
    const { riddle, answers } = pick(HOSTAGE_RIDDLES);

    await channel.send(
      [
        '🚨 **AUTOMATED DELIVERY ALERT** 🚨',
        '',
        'Our AI delivery driver, **Unit-7 "Gary"**, has intercepted your order:',
        '> *Double Protein Bowl (no beans) and a Mexican Sprite.*',
        '',
        'It is now being held hostage in the trunk of a 2014 Honda Civic.',
        '',
        'To secure its release you must answer the following riddle. You have **60 seconds**.',
        '',
        `❓ *${riddle}*`,
      ].join('\n')
    );

    const filter = (m) => m.author.id === targetId;
    const collector = trackCollector(
      entry,
      channel.createMessageCollector({ filter, time: 60000, max: 1 })
    );

    collector.on('collect', async (m) => {
      const guess = m.content.toLowerCase().trim();
      const correct = answers.some((a) => guess.includes(a.toLowerCase()));
      if (correct) {
        await m.reply(
          'Correct! Unit-7 "Gary" has released your order... and then immediately ate it himself. He says it was *incredible*. No refunds. 🫡'
        );
      } else {
        await m.reply(
          `Incorrect. Gary is **disgusted** by that answer. The Double Protein Bowl has been thrown into a ditch out of pure secondhand embarrassment. (The answer was *${answers[0]}*, obviously.)`
        );
      }
      collector.stop('answered');
    });

    collector.on('end', (_collected, reason) => {
      entry.state.armed = false; // allow the bit to run again later
      if (reason === 'time') {
        channel
          .send(
            "⏰ Time's up. Gary got bored, finished your Mexican Sprite, and drove off into the sunset. Your order is gone. Hope you're happy."
          )
          .catch(() => {});
      }
    });
  },

  // ---------------------------------------------------------------------------
  // Mode 11: InvertedEcho — swap words for their antonyms and "correct" them.
  // ---------------------------------------------------------------------------
  async InvertedEcho(message, entry) {
    let swapped = false;
    const inverted = message.content.replace(/[A-Za-z']+/g, (word) => {
      const lower = word.toLowerCase();
      const antonym = ANTONYMS.get(lower);
      if (!antonym) return word;
      swapped = true;
      // Preserve leading capitalization of the original word.
      return /^[A-Z]/.test(word)
        ? antonym.charAt(0).toUpperCase() + antonym.slice(1)
        : antonym;
    });

    if (!swapped) {
      await message.reply(
        "*Actually, I think you'll find you're wrong, but I'll allow it this once.*"
      );
      return;
    }

    await message.reply(`\\*${inverted}\n*(There. Fixed your opinion for you.)*`);
  },

  // ---------------------------------------------------------------------------
  // Mode 12: WordSpammer — repeat a word every 3s, hard-capped at 15 messages.
  // Optional arg = the word; otherwise grab the last word of the next message.
  // ---------------------------------------------------------------------------
  async WordSpammer(message, entry) {
    if (entry.state.busy) return; // only one spam run at a time
    entry.state.busy = true;
    try {
      const targetId = message.author.id;
      const channel = message.channel;

      // Resolve the word: explicit arg wins, else last word of this message.
      let word = (entry.args || '').trim().split(/\s+/)[0];
      if (!word) {
        const words = message.content.trim().split(/\s+/).filter(Boolean);
        word = words[words.length - 1];
      }
      if (!word) {
        entry.state.busy = false;
        return; // nothing usable; wait for a message that has a word
      }

      const MAX_MESSAGES = 15; // safety hardcap so the token doesn't get banned
      for (let i = 0; i < MAX_MESSAGES; i++) {
        if (!isLive(targetId, entry)) return;
        await channel.send(word);
        await sleep(3000); // every 3 seconds
      }

      if (isLive(targetId, entry)) {
        await channel.send('Spam sequence complete.');
      }
      // Auto-disengage the mode.
      const live = activeModes.get(targetId);
      if (live === entry) {
        teardown(entry);
        activeModes.delete(targetId);
      }
    } finally {
      entry.state.busy = false;
    }
  },
};

// Case-insensitive lookup table: lowercased mode name -> canonical name.
const MODE_LOOKUP = new Map(
  Object.keys(modes).map((name) => [name.toLowerCase(), name])
);

// -----------------------------------------------------------------------------
// Owner command handling
// -----------------------------------------------------------------------------

async function handleOwnerCommand(message) {
  const content = message.content.trim();
  if (!content.startsWith('!')) return;

  const [command, ...rest] = content.slice(1).split(/\s+/);
  const cmd = command.toLowerCase();

  if (cmd === 'troll') {
    const [targetId, modeName, ...argParts] = rest;
    if (!targetId || !modeName) {
      await message.reply(
        'Usage: `!troll <TargetUserID> <ModeName> [optional args]`'
      );
      return;
    }
    if (!/^\d{5,25}$/.test(targetId)) {
      await message.reply(
        `\`${targetId}\` doesn't look like a valid Discord user ID.`
      );
      return;
    }

    const canonical = MODE_LOOKUP.get(modeName.toLowerCase());
    if (!canonical) {
      await message.reply(
        `Unknown mode \`${modeName}\`.\nAvailable: ${Object.keys(modes).join(
          ', '
        )}`
      );
      return;
    }

    // Confirm the target is reachable and pre-open a DM channel.
    let targetUser;
    try {
      targetUser = await client.users.fetch(targetId);
      await targetUser.createDM();
    } catch {
      await message.reply(
        `Couldn't reach a user with ID \`${targetId}\`. Do we share a server / can they receive DMs?`
      );
      return;
    }

    // Replace any existing mode for this target (tear down its timers first).
    const existing = activeModes.get(targetId);
    if (existing) teardown(existing);

    const entry = {
      mode: canonical,
      args: argParts.join(' '),
      state: makeState(),
    };
    activeModes.set(targetId, entry);

    await message.reply(
      `✅ Activated **${canonical}** on \`${targetUser.tag}\` (\`${targetId}\`)` +
        (entry.args ? ` with args: \`${entry.args}\`` : '') +
        '.'
    );
    return;
  }

  if (cmd === 'stop') {
    const [targetId] = rest;
    if (!targetId) {
      await message.reply('Usage: `!stop <TargetUserID>`');
      return;
    }
    const entry = activeModes.get(targetId);
    if (!entry) {
      await message.reply(`No active mode on \`${targetId}\`.`);
      return;
    }
    teardown(entry);
    activeModes.delete(targetId);
    await message.reply(`🛑 Cleared **${entry.mode}** on \`${targetId}\`.`);
    return;
  }

  if (cmd === 'status') {
    if (activeModes.size === 0) {
      await message.reply('No active trolls right now. A peaceful kingdom.');
      return;
    }
    const lines = [...activeModes.entries()].map(
      ([id, entry]) =>
        `• \`${id}\` → **${entry.mode}**${
          entry.args ? ` (args: \`${entry.args}\`)` : ''
        }`
    );
    await message.reply(
      `**Active trolls (${activeModes.size}):**\n${lines.join('\n')}`
    );
    return;
  }

  await message.reply(
    'Unknown command. Available: `!troll`, `!stop`, `!status`.'
  );
}

// -----------------------------------------------------------------------------
// Gateway events
// -----------------------------------------------------------------------------

client.once('clientReady', (c) => {
  console.log(`[READY] Logged in as ${c.user.tag}. Owner: ${OWNER_ID}`);
  console.log(`[READY] ${Object.keys(modes).length} troll modes loaded.`);
});

client.on('messageCreate', async (message) => {
  try {
    // Resolve partial DM messages before touching their content.
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return;
      }
    }

    if (message.author?.bot) return; // never react to bots (or ourselves)
    if (message.channel.type !== ChannelType.DM) return; // DMs only

    // Owner -> command parser.
    if (message.author.id === OWNER_ID) {
      await handleOwnerCommand(message);
      return;
    }

    // Anyone else -> run their active mode, if any.
    const entry = activeModes.get(message.author.id);
    if (!entry) return;

    const handler = modes[entry.mode];
    if (handler) await handler(message, entry);
  } catch (err) {
    console.error('[messageCreate] handler error:', err);
  }
});

client.on('error', (err) => console.error('[client error]', err));
process.on('unhandledRejection', (err) =>
  console.error('[unhandledRejection]', err)
);

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

client.login(DISCORD_TOKEN);
