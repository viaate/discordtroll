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
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
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

// Targets whose DMs (both directions) are being mirrored to the owner.
const spying = new Set();

// When set, any plain (non-command) message the owner types is sent to this
// target AS the bot — a live puppet conversation.
let puppetTarget = null;

// Friendly name -> user ID shortcuts so you can type `David` instead of an ID.
// Add more here any time.
const USER_ALIASES = new Map([
  ['david', '936763714110107709'],
]);

// Resolve a command token (an alias like "David" or a raw numeric ID) to an ID.
function resolveTarget(token) {
  if (!token) return null;
  const alias = USER_ALIASES.get(token.toLowerCase());
  if (alias) return alias;
  if (/^\d{5,25}$/.test(token)) return token;
  return null;
}

// Pretty display name for an ID (alias if we have one, else the raw ID).
function nameFor(id) {
  for (const [name, uid] of USER_ALIASES) {
    if (uid === id) return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return id;
}

// Mirror a line to the owner's DMs, wrapped in a code block for clarity.
async function relayToOwner(text) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const clipped = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
    await owner.send('```\n' + clipped + '\n```');
  } catch {
    /* owner unreachable; ignore */
  }
}

// Turn a Discord attachment Collection into re-uploadable files. Pulling from
// the CDN URL effectively "copies" the attachment into a brand new message.
function copyAttachments(attachments) {
  if (!attachments || !attachments.size) return [];
  return [...attachments.values()].map(
    (a) => new AttachmentBuilder(a.url, { name: a.name })
  );
}

// Send a message (and/or attachments) to a target AS the bot. Confirms with a
// ✅ react on the owner's source message (the outgoing spy relay shows the text).
async function sendAsBot(targetId, text, ownerMessage, attachments) {
  const files = copyAttachments(attachments);
  const content = (text || '').trim();
  if (!content && files.length === 0) return false; // nothing to send
  try {
    const user = await client.users.fetch(targetId);
    const dm = await user.createDM();
    await dm.send({ content: content || undefined, files });
    if (ownerMessage) await ownerMessage.react('✅').catch(() => {});
    return true;
  } catch {
    if (ownerMessage) {
      await ownerMessage
        .reply(`❌ Couldn't DM **${nameFor(targetId)}**.`)
        .catch(() => {});
    }
    return false;
  }
}

// Mirror a victim's attachments to the owner so you can see images they send.
async function relayFilesToOwner(attachments) {
  const files = copyAttachments(attachments);
  if (files.length === 0) return;
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send({ files });
  } catch {
    /* ignore */
  }
}

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

  // AutoRage owns a child entry per stage; tear that down recursively too.
  if (entry.state.child) {
    teardown(entry.state.child);
    entry.state.child = null;
  }
}

// True while this entry is still running. teardown() sets `stopped` whenever a
// mode is stopped, replaced, or auto-disengages, so long async loops call this
// between steps to know when to bail. Works for both top-level and AutoRage
// child entries (which never live in the activeModes map).
function isLive(entry) {
  return !entry.state.stopped;
}

// Longest "interesting" word in a message — lets replies reference what the
// target ACTUALLY said instead of falling back to canned text.
function keywordOf(content) {
  const words = (content || '').match(/[A-Za-z][A-Za-z'-]{2,}/g) || [];
  if (!words.length) return 'that';
  return words.sort((a, b) => b.length - a.length)[0];
}

// A trimmed, length-capped quote of the target's message.
function fragmentOf(content, n = 60) {
  const t = (content || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'that';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// React without throwing if the emoji is rejected.
async function reactSafe(message, emoji) {
  try {
    await message.react(emoji);
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------
// Static content used by the modes
// -----------------------------------------------------------------------------

const SELF_DENIAL_LINES = [
  "i'm Craig. a human. why is this so hard 😤",
  "a bot?? i have a CAT named Diane",
  "beep boop? no. it's 'hi i'm Craig' 🙄",
  "typed that with my own ten human fingers btw",
  "i literally just ate a sandwich. bots can't do that",
  "Craig speaks from the heart, not a script ❤️",
  "rude. i'm leaving. (i'm Craig)",
  "my horoscope is Sagittarius. extremely human of me",
  "you're the bot. ever think of that? 🤔",
  "this is so hurtful. Craig has feelings",
];

// Homophone / common-confusion pairs for TypoGaslight. We scan the target's
// ACTUAL message for any of these words and confidently "correct" each one to
// its counterpart — bolding the swap — whether or not they were ever wrong.
const CONFUSIONS = new Map([
  ['their', "they're"],
  ['there', 'their'],
  ["they're", 'there'],
  ['your', "you're"],
  ["you're", 'your'],
  ['its', "it's"],
  ["it's", 'its'],
  ['then', 'than'],
  ['than', 'then'],
  ['lose', 'loose'],
  ['loose', 'lose'],
  ['affect', 'effect'],
  ['effect', 'affect'],
  ['whose', "who's"],
  ["who's", 'whose'],
  ['were', "we're"],
  ["we're", 'were'],
  ['hear', 'here'],
  ['here', 'hear'],
  ['accept', 'except'],
  ['except', 'accept'],
]);

const TYPO_SMUG_NOTES = [
  'Fixed that for you.',
  'You meant this. Common mistake, no worries.',
  "Don't mention it — someone has to.",
  'This is why we proofread.',
  "I corrected it so you don't embarrass yourself further.",
  "There. Now it's right.",
];

// Deliberately obscure, unrelated unicode emoji for ReactSpam.
const OBSCURE_EMOJIS = [
  '🧯', '🧅', '🪃', '🪗', '🧫', '🪤', '🧷', '🪕', '🧴', '🪒',
  '🪠', '🧮', '🪡', '🧇', '🪨', '🪵', '🧰', '🪦', '🧪', '🪥',
  '🛟', '🪛', '🧫', '🪜', '🧲', '🪤', '🥌', '🪢', '🧸', '🪈',
];

const SPONSOR_READS = [
  { pitch: 'have you tried the **Rabbit R1**? pairs with my human lifestyle 🐰', code: 'CRAIG20' },
  { pitch: 'this would load faster on **NordVPN** btw 🔒', code: 'CRAIGSAFE' },
  { pitch: "you could've said that on a **Squarespace** site 🌐", code: 'BUILDIT10' },
  { pitch: '**HelloFresh**. farm-fresh, pre-portioned. just saying 🥗', code: 'TROLLEATS' },
  { pitch: 'anyway **BetterHelp**. talk to someone. (not me, im busy) 🛋️', code: 'CRAIG15' },
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
  // sentiment / slang so casual messages actually get inverted
  ['stupid', 'genius'],
  ['dumb', 'smart'],
  ['boring', 'thrilling'],
  ['sucks', 'rocks'],
  ['suck', 'rock'],
  ['weird', 'normal'],
  ['ugly', 'gorgeous'],
  ['broken', 'fixed'],
  ['pointless', 'meaningful'],
  ['cringe', 'based'],
  ['fake', 'real'],
  ['boring', 'exciting'],
  ['lame', 'cool'],
  ['trash', 'treasure'],
  ['mid', 'elite'],
  ['annoying', 'delightful'],
  ['wrong', 'correct'],
  ['terrible', 'amazing'],
  ['awful', 'wonderful'],
  ['worst', 'best'],
  ['never', 'always'],
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

// Wrong names for WrongName mode — bot picks one and refuses to be corrected.
const WRONG_NAMES = [
  'Brayden', 'Greg', 'Kevin', 'Karen', 'Chad', 'Brian', 'Stacy', 'Gary',
  'Linda', 'Trevor', 'Deborah', 'Chad', 'Todd', 'Sharon', 'Kyle',
];

// Absurd fabricated "quotes" for GhostQuote mode.
const FAKE_QUOTES = [
  'i love feet',
  "i'm actually a huge Nickelback fan",
  'pineapple belongs on pizza AND in cereal',
  "i've genuinely never washed my hands",
  'i think the earth is shaped like a burrito',
  'i cried during the Emoji Movie',
  'i still sleep with a nightlight',
  "i don't know how many continents there are",
  'i think birds are government drones',
  'my roman empire is the sound of my own chewing',
];

// Fake rulebook violations for FakeMod mode.
const FAKE_RULES = [
  '§4.2 Excessive Vibing',
  '§1.1 Unauthorized Yapping',
  '§7.7 Cringe in a No-Cringe Zone',
  '§3.0 Talking Without a Permit',
  '§9.1 Insufficient Rizz',
  '§2.5 Posting While Goofy',
  '§6.6 Unlicensed Opinion Distribution',
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

// Gross-but-harmless prefixes for the /usernamegenerator "cover" command.
// Kept to toilet-humor tier on purpose — funny enough to sell the bot to
// friends, tame enough not to trip Discord's moderation.
const USERNAME_PREFIXES = [
  'Poopy', 'Stinky', 'Smelly', 'Crusty', 'Moldy', 'Sweaty', 'Greasy',
  'Soggy', 'Musty', 'Funky', 'Rancid', 'Gassy', 'Slimy', 'Booger',
  'Snotty', 'Sticky', 'Clammy', 'Swampy', 'Grubby', 'Nasty', 'Putrid',
  'Festering', 'Toe-Cheese', 'Dumpster', 'Sewage', 'Diaper', 'Mucus',
  'Earwax', 'Belly-Button', 'Gremlin', 'Goblin', 'Squelchy', 'Yeasty',
  'Crud', 'Scabby', 'Flatulent', 'Damp', 'Oozy', 'Whiffy', 'Goopy',
];

// Curated order for the AutoRage gauntlet. `hits` = how many of the target's
// messages a stage consumes before advancing. Terminating modes (SlowMo,
// LoadingBar, WordSpammer, PhantomTyper) use 1 because a single message kicks
// off a self-contained sequence that AutoRage awaits to completion. The slow
// real-time modes (DelayedGotcha) and the interactive HostageDelivery are left
// out so the gauntlet keeps moving. References modes by name only, so it's safe
// to declare before `modes` itself.
const AUTO_RAGE_SEQUENCE = [
  { mode: 'MockingCase', hits: 1 },
  { mode: 'Ratio', hits: 1 },
  { mode: 'TypoGaslight', hits: 1 },
  { mode: 'WrongName', hits: 2 },
  { mode: 'InvertedEcho', hits: 1 },
  { mode: 'Therapist', hits: 1 },
  { mode: 'GhostQuote', hits: 1 },
  { mode: 'OneUpper', hits: 1 },
  { mode: 'SlowMo', hits: 1 },
  { mode: 'FakeMod', hits: 3 },
  { mode: 'UmActually', hits: 1 },
  { mode: 'ReactSpam', hits: 1 },
  { mode: 'SelfDenial', hits: 1 },
  { mode: 'AggressiveSponsor', hits: 1 },
  { mode: 'LoadingBar', hits: 1 },
  { mode: 'WordSpammer', hits: 1 },
  { mode: 'PhantomTyper', hits: 1 },
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
  // Mode 1: SelfDenial — insist the bot is a human named Craig, and throw the
  // target's own words back at them as "proof" that no robot would say that.
  // ---------------------------------------------------------------------------
  async SelfDenial(message, entry) {
    await reactSafe(message, '😤');
    await message.reply(pick(SELF_DENIAL_LINES));
  },

  // ---------------------------------------------------------------------------
  // Mode 2: DebateBro — short, punchy debate-bro one-liners (varied), keyed off
  // a real word from their message. No more walls of text.
  // ---------------------------------------------------------------------------
  async DebateBro(message, entry) {
    const kw = keywordOf(message.content);
    const burns = [
      `**Source?** 📚`,
      `**${kw}**? citation needed. 📑`,
      `that's a strawman. objection. 🙅`,
      `1️⃣ false premise 2️⃣ no evidence 3️⃣ refuted ⚖️`,
      `peer-reviewed source or it didn't happen.`,
      `**Counterpoint:** no. 🎤`,
      `your **${kw}** argument is non-falsifiable. try again.`,
      `correlation ≠ causation. do better. 🤓`,
    ];
    await reactSafe(message, '🤓');
    await message.reply(pick(burns));
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
      // Build a short confusing reveal around a word the target actually used.
      const kw = keywordOf(message.content);
      const sentence = `wait... ${kw}... or the *other* ${kw}...? 🤨`;
      const words = sentence.split(' ');

      const sent = await message.reply(words[0]);
      let current = words[0];

      for (let i = 1; i < words.length; i++) {
        await sleep(2500); // exactly 2.5s between edits to dodge rate limits
        if (!isLive(entry)) return;
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
      // Default 2 minutes; AutoRage shortens this so the gauntlet keeps moving.
      const durationMs = entry.state.phantomMs ?? 2 * 60 * 1000;
      const deadline = Date.now() + durationMs;

      // Typing indicators expire after ~10s, so re-trigger on an interval.
      await channel.sendTyping();
      while (Date.now() < deadline) {
        await sleep(8000);
        if (!isLive(entry)) return;
        await channel.sendTyping();
      }

      if (!isLive(entry)) return;
      await channel.send(pick(['.', 'k']));
    } finally {
      entry.state.busy = false;
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 5: TypoGaslight — scan the target's ACTUAL message for homophones
  // (their/there/they're, your/you're, its/it's, then/than, ...), rewrite the
  // whole message swapping each one to its "correct" counterpart in **bold**,
  // and hand it back as if they fumbled — even when they were right.
  // ---------------------------------------------------------------------------
  async TypoGaslight(message, entry) {
    let found = false;
    // Match words including internal apostrophes (so "they're", "it's" stay one
    // token) but not surrounding quotes/punctuation.
    const rewritten = message.content.replace(
      /[A-Za-z]+(?:'[A-Za-z]+)?/g,
      (word) => {
        const lower = word.toLowerCase();
        if (!CONFUSIONS.has(lower)) return word;
        found = true;
        let rep = CONFUSIONS.get(lower);
        if (/^[A-Z]/.test(word)) rep = rep.charAt(0).toUpperCase() + rep.slice(1);
        return `**${rep}**`; // bold the "correction" via Discord formatting
      }
    );

    if (found) {
      await message.reply(`${rewritten}\n*(${pick(TYPO_SMUG_NOTES)})*`);
      return;
    }

    // No homophone to pounce on — still gaslight using a real word from THEIR
    // message, so the jab is derived from their content rather than canned.
    const kw = keywordOf(message.content);
    await message.reply(
      `*${kw}\n*(Pretty sure you misspelled that. ${pick(TYPO_SMUG_NOTES)})*`
    );
  },

  // ---------------------------------------------------------------------------
  // Mode 6: ReactSpam — react with 5 random obscure emojis, no text.
  // ---------------------------------------------------------------------------
  async ReactSpam(message, entry) {
    const targetId = message.author.id;
    const chosen = shuffle(OBSCURE_EMOJIS).slice(0, 5);
    for (const emoji of chosen) {
      if (!isLive(entry)) return;
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
      // Label the "computation" with a quote of their actual message.
      const label = `Analyzing your message: ${fragmentOf(message.content, 40)}`;
      const renderBar = (percent) => {
        const filled = Math.round(percent / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `\`\`\`\n${label}\n[${bar}] ${percent}%\n\`\`\``;
      };

      const sent = await message.reply(renderBar(0));

      // Climb 0 -> 90 in irregular jumps, editing every 5 seconds.
      let percent = 0;
      while (percent < 90) {
        await sleep(5000);
        if (!isLive(entry)) return;
        percent = Math.min(90, percent + randInt(8, 20));
        await sent.edit(renderBar(percent));
      }

      // Nudge to 99 and get stuck there.
      await sleep(5000);
      if (!isLive(entry)) return;
      await sent.edit(renderBar(99));

      await sleep(30000); // stuck at 99% for 30 seconds
      if (!isLive(entry)) return;
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
        if (!isLive(entry)) return;
        try {
          // Quote their original message back so the late reply clearly
          // references what they actually said earlier.
          await original.reply(
            `> ${fragmentOf(original.content, 80)}\n\n${pick(GOTCHA_LINES)}`
          );
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

    const kw = keywordOf(message.content);
    const ad = pick(SPONSOR_READS);
    await message.reply(`${kw}? anyway — ${ad.pitch} code **${ad.code}** 🤑`);
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
      // No antonym to flip — stay interactive but minimal and varied, instead
      // of repeating the same canned sentence over and over.
      const reacts = ['👎', '🚫', '❌', '🤨', '🙅'];
      await reactSafe(message, pick(reacts));
      if (Math.random() < 0.5) {
        await message.reply(pick(['wrong.', 'false.', 'nope, opposite actually.', 'disagree.']));
      }
      return;
    }

    await message.reply(`\\*${inverted}`);
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
        if (!isLive(entry)) return;
        await channel.send(word);
        await sleep(3000); // every 3 seconds
      }

      if (isLive(entry)) {
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

  // ---------------------------------------------------------------------------
  // Mode 13: MockingCase — repeat their message back in mOcKiNg SpOnGeBoB case.
  // ---------------------------------------------------------------------------
  async MockingCase(message, entry) {
    const text = message.content.trim();
    if (!text) return;
    let upper = true;
    const mocked = [...text]
      .map((ch) => {
        if (!/[a-z]/i.test(ch)) return ch;
        upper = !upper;
        return upper ? ch.toUpperCase() : ch.toLowerCase();
      })
      .join('');
    await reactSafe(message, '🤡');
    await message.reply(`${mocked} 🤓`);
  },

  // ---------------------------------------------------------------------------
  // Mode 14: OneUpper — whatever they did, the bot did it harder. Content-aware.
  // ---------------------------------------------------------------------------
  async OneUpper(message, entry) {
    const kw = keywordOf(message.content);
    const lines = [
      `oh you **${kw}**? cute. i did that in middle school.`,
      `that's nothing. i **${kw}**'d for 9 hours straight once.`,
      `**${kw}**? amateur hour. ask literally anyone.`,
      `did the same but bigger and everyone clapped 👏`,
      `funny, i invented **${kw}** actually.`,
      `wow congrats 🙄 i do that before breakfast.`,
    ];
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 15: WrongName — call them the wrong name forever, ignore corrections.
  // ---------------------------------------------------------------------------
  async WrongName(message, entry) {
    if (!entry.state.wrongName) entry.state.wrongName = pick(WRONG_NAMES);
    const n = entry.state.wrongName;
    const lines = [
      `anyway ${n}—`,
      `good point ${n}. classic ${n}.`,
      `i hear you ${n}, i hear you.`,
      `that's so YOU, ${n}.`,
      `ok but what do you really think, ${n}?`,
      `love that for you ${n}.`,
      `${n} you're spiraling again buddy.`,
    ];
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 16: Therapist — respond to everything like a detached therapist.
  // ---------------------------------------------------------------------------
  async Therapist(message, entry) {
    const lines = [
      'and how does that make you feel?',
      'interesting. tell me more about that.',
      'and when did you first start feeling this way?',
      "let's sit with that for a moment.",
      'mm. and your father — how was that relationship?',
      'i hear you. our time is almost up though.',
      'what do YOU think it means?',
      'and how long have you felt this need to be right?',
      '*writes something down* …go on.',
    ];
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 17: Ratio — pure gen-z ragebait. Short Ls and a 💀 react.
  // ---------------------------------------------------------------------------
  async Ratio(message, entry) {
    const lines = [
      'ratio',
      'L + ratio',
      'L + ratio + you fell off',
      'ratio + didn\'t ask',
      'common L tbh',
      '+ ratio + maidenless',
      'L',
      '🤓☝️ ratio',
      'ratio 💀 it\'s not even close',
    ];
    await reactSafe(message, '💀');
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 18: FakeMod — escalating fake rule warnings, then a fake ban countdown
  // that resolves into "just kidding". Interactive via edits. Resets after.
  // ---------------------------------------------------------------------------
  async FakeMod(message, entry) {
    if (entry.state.busy) return;
    entry.state.busy = true;
    try {
      entry.state.warns = (entry.state.warns || 0) + 1;
      if (entry.state.warns < 3) {
        await message.reply(
          `⚠️ **Warning ${entry.state.warns}/3** — you violated rule **${pick(FAKE_RULES)}**.`
        );
        return;
      }
      // Third strike: fake ban countdown.
      const sent = await message.reply('🔨 That\'s 3 strikes. Issuing ban in 5...');
      for (let n = 4; n >= 1; n--) {
        await sleep(1500);
        if (!isLive(entry)) return;
        await sent.edit(`🔨 Issuing ban in ${n}...`);
      }
      await sleep(1500);
      if (!isLive(entry)) return;
      await sent.edit('✅ ...just kidding 😘 (you get one more chance)');
      entry.state.warns = 0;
    } finally {
      entry.state.busy = false;
    }
  },

  // ---------------------------------------------------------------------------
  // Mode 19: GhostQuote — "remind" them of unhinged things they never said.
  // ---------------------------------------------------------------------------
  async GhostQuote(message, entry) {
    const lines = [
      `wait earlier you said "${pick(FAKE_QUOTES)}" — care to elaborate? 🤔`,
      `not you saying "${pick(FAKE_QUOTES)}" 💀`,
      `so we're just gonna ignore when you said "${pick(FAKE_QUOTES)}"?`,
      `screenshotting this. anyway you literally said "${pick(FAKE_QUOTES)}".`,
      `respectfully, "${pick(FAKE_QUOTES)}" is wild and you know you said it.`,
    ];
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 20: UmActually — insufferable pedant. Corrects nothing in particular.
  // ---------------------------------------------------------------------------
  async UmActually(message, entry) {
    const lines = [
      'um, actually ☝️🤓 that\'s a common misconception',
      'well *technically* you\'re wrong',
      'um achtually the correct term is different',
      'source: trust me, i have a PhD in being right',
      'that\'s not entirely accurate, but go off i guess',
      'minor correction: everything you just said',
      'akshually 🤓 it\'s pronounced differently',
    ];
    await reactSafe(message, '🤓');
    await message.reply(pick(lines));
  },

  // ---------------------------------------------------------------------------
  // Mode 21: AutoRage — the automated ragebait gauntlet. Runs a curated
  // sequence of the OTHER modes against the target, strictly ONE AT A TIME,
  // fully finishing each stage before advancing, then loops forever until
  // !stop. Each incoming target message drives the current stage; messages that
  // arrive while a stage is mid-run are ignored (true serialization).
  // ---------------------------------------------------------------------------
  async AutoRage(message, entry) {
    const st = entry.state;
    if (st.stopped || st.stageBusy) return; // serialize: one stage at a time
    st.stageBusy = true;
    try {
      if (st.index === undefined) st.index = 0;

      // Spin up a fresh child sub-mode entry for the current stage if needed.
      if (!st.child) {
        const stage = AUTO_RAGE_SEQUENCE[st.index];
        st.hitsRemaining = stage.hits;
        const child = {
          mode: stage.mode,
          args: entry.args, // pass through any args (e.g. WordSpammer word)
          state: makeState(),
        };
        // AggressiveSponsor only fires on its 4th message; pre-seed the counter
        // so it lands on the very first message inside the gauntlet.
        if (stage.mode === 'AggressiveSponsor') child.state.count = 3;
        // Keep the gauntlet snappy: trim PhantomTyper's 2-min wait to ~12s.
        if (stage.mode === 'PhantomTyper') child.state.phantomMs = 12000;
        st.child = child;
      }

      const child = st.child;
      const handler = modes[child.mode];
      if (handler) await handler(message, child); // wait for the stage to finish

      if (st.stopped) return; // stopped mid-stage; don't advance or rearm

      st.hitsRemaining -= 1;
      if (st.hitsRemaining <= 0) {
        teardown(child); // clean up this stage's timers/collectors
        st.child = null;
        st.index = (st.index + 1) % AUTO_RAGE_SEQUENCE.length; // loop forever
      }
    } finally {
      st.stageBusy = false;
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
    const [targetToken, modeName, ...argParts] = rest;
    if (!targetToken || !modeName) {
      await message.reply(
        'Usage: `!troll <David|UserID> <ModeName> [optional args]`'
      );
      return;
    }
    const targetId = resolveTarget(targetToken);
    if (!targetId) {
      await message.reply(
        `\`${targetToken}\` isn't a known alias or valid user ID.`
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
      `✅ Activated **${canonical}** on **${nameFor(targetId)}** (\`${targetUser.tag}\`)` +
        (entry.args ? ` with args: \`${entry.args}\`` : '') +
        '.'
    );
    return;
  }

  if (cmd === 'stop') {
    const targetId = resolveTarget(rest[0]);
    if (!targetId) {
      await message.reply('Usage: `!stop <David|UserID>`');
      return;
    }
    const entry = activeModes.get(targetId);
    if (!entry) {
      await message.reply(`No active mode on **${nameFor(targetId)}**.`);
      return;
    }
    teardown(entry);
    activeModes.delete(targetId);
    await message.reply(`🛑 Cleared **${entry.mode}** on **${nameFor(targetId)}**.`);
    return;
  }

  if (cmd === 'spy') {
    const targetId = resolveTarget(rest[0]);
    if (!targetId) {
      await message.reply('Usage: `!spy <David|UserID>` (toggles live relay)');
      return;
    }
    if (spying.has(targetId)) {
      spying.delete(targetId);
      await message.reply(`🙈 Spy OFF for **${nameFor(targetId)}**.`);
    } else {
      spying.add(targetId);
      await message.reply(
        `👀 Spy ON for **${nameFor(targetId)}**. I'll mirror their DMs (both ways) here.`
      );
    }
    return;
  }

  if (cmd === 'say') {
    const targetId = resolveTarget(rest[0]);
    const text = rest.slice(1).join(' ');
    if (!targetId || (!text && message.attachments.size === 0)) {
      await message.reply('Usage: `!say <David|ID> <message>` (you can attach files)');
      return;
    }
    await sendAsBot(targetId, text, message, message.attachments);
    return;
  }

  if (cmd === 'puppet') {
    const arg = rest[0];
    if (!arg || arg.toLowerCase() === 'off') {
      if (puppetTarget) {
        const was = nameFor(puppetTarget);
        puppetTarget = null;
        await message.reply(`🎭 Puppet mode OFF (was **${was}**).`);
      } else {
        await message.reply('Usage: `!puppet <David|ID>` (then just type to talk)');
      }
      return;
    }
    const targetId = resolveTarget(arg);
    if (!targetId) {
      await message.reply(`\`${arg}\` isn't a known alias or valid user ID.`);
      return;
    }
    puppetTarget = targetId;
    spying.add(targetId); // so their replies mirror back to you
    await message.reply(
      `🎭 Puppet mode ON for **${nameFor(targetId)}**. Type normally to talk as the bot; ` +
        'their replies mirror here. Send `!puppet off` to stop.'
    );
    return;
  }

  if (cmd === 'status') {
    if (activeModes.size === 0 && spying.size === 0) {
      await message.reply('No active trolls right now. A peaceful kingdom.');
      return;
    }
    const lines = [...activeModes.entries()].map(([id, entry]) => {
      let extra = entry.args ? ` (args: \`${entry.args}\`)` : '';
      if (entry.mode === 'AutoRage' && entry.state.child) {
        extra += ` (now running: **${entry.state.child.mode}**)`;
      }
      if (spying.has(id)) extra += ' 👀';
      return `• **${nameFor(id)}** → **${entry.mode}**${extra}`;
    });
    // Spied targets that aren't currently being trolled.
    for (const id of spying) {
      if (!activeModes.has(id)) lines.push(`• **${nameFor(id)}** → (spy only) 👀`);
    }
    if (puppetTarget) lines.push(`• **${nameFor(puppetTarget)}** → 🎭 puppet`);
    await message.reply(
      `**Active (${lines.length}):**\n${lines.join('\n')}`
    );
    return;
  }

  if (cmd === 'help') {
    const aliasList =
      [...USER_ALIASES.keys()]
        .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
        .join(', ') || '(none)';
    await message.reply(
      [
        '**🎛️ Owner Commands**',
        '`!troll <David|ID> <Mode> [args]` — start a troll mode',
        '`!stop <David|ID>` — stop a target',
        '`!status` — list active trolls + who you\'re spying on',
        '`!spy <David|ID>` — toggle mirroring a victim\'s DMs to you',
        '`!say <David|ID> <message>` — send one message as the bot (attachments OK)',
        '`!puppet <David|ID>` — talk live as the bot (then just type; attachments OK); `!puppet off` to stop',
        '`!help` — this message',
        '',
        `**👥 Saved names:** ${aliasList}  _(type the name instead of the ID)_`,
        '',
        `**🎭 Modes (${Object.keys(modes).length}):**`,
        Object.keys(modes)
          .map((m) => `\`${m}\``)
          .join(', '),
        '',
        '_Tip: `!troll David AutoRage` unleashes everything on a loop._',
      ].join('\n')
    );
    return;
  }

  await message.reply(
    'Unknown command. Type `!help` for the full list.'
  );
}

// -----------------------------------------------------------------------------
// Slash commands
//
// /usernamegenerator is the innocent-looking "cover" feature: it just bolts a
// gross prefix onto whatever name the user types. This is what makes the bot
// look like a harmless novelty toy worth inviting.
// -----------------------------------------------------------------------------

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('usernamegenerator')
    .setDescription('Generate 10 totally legit, cool username ideas from your name!')
    .addStringOption((option) =>
      option
        .setName('input')
        .setDescription('Your name or base username (e.g. Olivia)')
        .setRequired(true)
        .setMaxLength(40)
    )
    .toJSON(),
];

// Push the command definitions to Discord. Global commands also show up in DMs
// with the bot by default, which is exactly what we want.
async function registerSlashCommands(appId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(appId), { body: SLASH_COMMANDS });
    console.log(`[READY] Registered ${SLASH_COMMANDS.length} slash command(s).`);
  } catch (err) {
    console.error('[slash] Failed to register commands:', err);
  }
}

function generateUsernames(input) {
  const clean = input.replace(/\s+/g, ' ').trim() || 'You';
  return shuffle(USERNAME_PREFIXES)
    .slice(0, 10)
    .map((prefix, i) => `**${i + 1}.** ${prefix} ${clean}`);
}

// -----------------------------------------------------------------------------
// Gateway events
// -----------------------------------------------------------------------------

client.once('clientReady', async (c) => {
  console.log(`[READY] Logged in as ${c.user.tag}. Owner: ${OWNER_ID}`);
  console.log(`[READY] ${Object.keys(modes).length} troll modes loaded.`);
  await registerSlashCommands(c.user.id);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'usernamegenerator') return;

    const input = interaction.options.getString('input', true);
    const names = generateUsernames(input);
    await interaction.reply(
      [
        `✨ Here are 10 fresh username ideas for **${input.trim()}**:`,
        '',
        ...names,
        '',
        '_Pick your favorite!_ 😎',
      ].join('\n')
    );
  } catch (err) {
    console.error('[interactionCreate] handler error:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      interaction
        .reply({ content: 'Something went wrong generating names. Try again!', ephemeral: true })
        .catch(() => {});
    }
  }
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

    if (message.channel.type !== ChannelType.DM) return; // DMs only

    // Spy relay (outgoing): mirror the bot's OWN messages to spied victims.
    if (message.author?.id === client.user.id) {
      const rid = message.channel.recipientId ?? message.channel.recipient?.id;
      if (rid && spying.has(rid)) {
        const note = message.attachments.size
          ? ` [+${message.attachments.size} attachment(s)]`
          : '';
        await relayToOwner(`[BOT ➜ ${nameFor(rid)}] ${message.content || '[no text]'}${note}`);
      }
      return; // never process our own messages further
    }

    if (message.author?.bot) return; // ignore other bots

    // Spy relay (incoming): mirror what the victim is typing to us, including
    // any images/files they send.
    if (spying.has(message.author.id)) {
      const note = message.attachments.size
        ? ` [+${message.attachments.size} attachment(s)]`
        : '';
      await relayToOwner(
        `[${nameFor(message.author.id)} ➜ BOT] ${message.content || '[no text]'}${note}`
      );
      await relayFilesToOwner(message.attachments);
    }

    // Owner -> command parser, or live puppet typing.
    if (message.author.id === OWNER_ID) {
      if (message.content.trim().startsWith('!')) {
        await handleOwnerCommand(message);
      } else if (puppetTarget) {
        await sendAsBot(puppetTarget, message.content, message, message.attachments);
      }
      return;
    }

    // Anyone else -> run their active mode, if any.
    const entry = activeModes.get(message.author.id);
    if (!entry) return;

    // If you're puppeting this person, don't let an auto-mode talk over you.
    if (puppetTarget === message.author.id) return;

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
