// Pure script parse / prompt / clean. No I/O, no network.
// ponytail: splitOversized duplicated from audio.js — D2 forbids exporting it from audio.js.

export const SEGMENT_CHARS = 1800;
export const MULTI_BLOCK_CHARS = 3000;
export const WPM = 150;
export const TURN_RE = /^Speaker\s+(10|[1-9])\s*:\s*(.*)/i;
export const TITLE_RE = /^Title:\s*(.*)\s*$/i;

export const ACTIONS = [
  'write',
  'podcastify',
  'improve',
  'lengthen',
  'shorten',
  'expressions',
  'translate',
];

const INTENSITY_KEYS = {
  subtle: 'Subtle',
  expressive: 'Expressive',
  dramatic: 'Dramatic',
};

const INTENSITY_INSTRUCTIONS = {
  Subtle:
    'Your use of tags should be very subtle and sparse. Focus on natural pauses (`[short pause]`) and occasional, mild emphasis to improve flow. Avoid strong emotions like `[shouting]` or `[laughing]` unless absolutely essential to the text.',
  Expressive:
    'Use a balanced variety of tags to make the performance engaging. Add a mix of pauses, emotional cues (`[happy]`, `[curious]`), and style modifiers where appropriate. The goal is a lively, conversational performance.',
  Dramatic:
    'Your use of tags should be frequent and impactful for a highly animated performance. Do not hesitate to use strong emotional cues (`[shouting]`, `[sarcastic]`, `[excited]`) and pacing tags (`[long pause]`, `[very fast]`) to maximize the dramatic effect.',
};

export function parseScript(text) {
  const src = String(text ?? '');
  let title = '';
  const turns = [];
  const speakersUsed = new Set();
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!title && TITLE_RE.test(line)) {
      title = line.replace(TITLE_RE, '$1').trim();
      continue;
    }
    const match = line.match(TURN_RE);
    if (match) {
      const speaker = Number(match[1]);
      const t = match[2].trim();
      if (!t) continue;
      turns.push({ speaker, text: t });
      speakersUsed.add(speaker);
      continue;
    }
    if (turns.length > 0) {
      turns[turns.length - 1].text += ` ${line}`;
    }
  }
  return { title, turns, speakersUsed };
}

export function estimateSeconds(scriptText) {
  let clean = String(scriptText ?? '').replace(/^Title:.*$/im, '');
  clean = clean.replace(/Speaker\s+(10|[1-9])\s*:/gi, '');
  clean = clean.replace(/\[[^\]]*\]/g, '');
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  const estSeconds = wordCount === 0 ? 0 : Math.floor((wordCount / WPM) * 60);
  return { wordCount, estSeconds };
}

export function targetWordCount(currentSeconds, deltaSeconds) {
  const targetTotalSeconds = Math.max(0, currentSeconds + deltaSeconds);
  return {
    targetTotalSeconds,
    targetWordCount: Math.floor((targetTotalSeconds / 60) * WPM),
  };
}

export function splitOversized(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  const boundary = /[.!?…]\s+/g;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let last = -1;
    boundary.lastIndex = 0;
    let m;
    while ((m = boundary.exec(window))) last = m.index + m[0].length;
    if (last > 0) {
      parts.push(rest.slice(0, last).trimEnd());
      rest = rest.slice(last).trimStart();
    } else {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  if (rest) parts.push(rest);
  return parts;
}

export function groupMultiBlocks(turns, maxChars = MULTI_BLOCK_CHARS) {
  const blocks = [];
  let current = [];
  let chars = 0;
  for (const turn of turns) {
    if (turn.text.length > maxChars) {
      if (current.length) {
        blocks.push(current);
        current = [];
        chars = 0;
      }
      for (const chunk of splitOversized(turn.text, maxChars)) {
        blocks.push([{ speaker: turn.speaker, text: chunk }]);
      }
      continue;
    }
    const add = turn.text.length + (current.length ? 1 : 0);
    if (current.length && chars + add > maxChars) {
      blocks.push(current);
      current = [];
      chars = 0;
    }
    current.push(turn);
    chars += turn.text.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

export function cleanModelOutput(input) {
  let text;
  if (Array.isArray(input)) {
    text = input
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  } else {
    text = String(input ?? '');
  }
  text = text.trim();
  const fence = text.match(/^```(?:[^\n]*)\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  return text;
}

function profileLines(speakers, voiceTraits) {
  return speakers
    .map((s, i) => {
      const traits = voiceTraits?.[s.voice] ?? s.voice;
      return `- Speaker ${i + 1} has the name **${s.name}**. Their voice is described as "${s.voice} (${traits})" for context.`;
    })
    .join('\n');
}

function lengthClause(targetMinutes) {
  if (!targetMinutes) return '';
  return `\n7. **LENGTH:** The final script should be long enough to last for approximately **${targetMinutes} minutes** when spoken at a normal pace.`;
}

/**
 * Port of podcast_studio_gemini/index.html writer prompts (lines 2085–2522).
 * Only changes: speaker profiles from speakers+VOICE_TRAITS; translate drops name localisation.
 */
export function buildPrompt(opts) {
  const {
    action,
    speakers,
    language = 'English',
    topic,
    sourceText,
    script,
    targetMinutes,
    deltaSeconds,
    intensity = 'expressive',
    targetLanguage,
    voiceTraits,
  } = opts;
  const numSpeakers = speakers.length;
  const speakerProfiles = `${profileLines(speakers, voiceTraits)}\n`;
  const names = speakers.map((s) => s.name);
  const name2 = names[1] || 'Speaker 2';

  if (action === 'write') {
    return `You are a creative scriptwriter. Your task is to write a short, engaging podcast script in ${language} based on the user's topic and speaker profiles.

**VERY IMPORTANT INSTRUCTIONS:**
1.  **LANGUAGE:** The entire script, including the title, MUST be written in **${language}**.
2.  **FORMATTING:** The script MUST adhere to this format:
    - The very first line is the title, like "Title: [Your Engaging Podcast Title]".
    - Every line of dialogue MUST start with "Speaker #:", for example, "Speaker 1:".
3.  **SPEAKERS:** You MUST write a script for exactly ${numSpeakers} speakers. Their profiles are below.
${speakerProfiles}
4.  **USE NAMES IN DIALOGUE:** When speakers talk to each other, they should sometimes use each other's names (e.g., "That's a great point, ${name2}."). Use names naturally to make the conversation flow, but not in every single line.
5.  **CONTENT:** Generate ONLY the title and dialogue. You MUST NOT include any non-speech audio cues, sound effects, or stage directions in brackets (e.g., [outro music], [sound of door opening]). The "Add Expressions" feature handles expressive markup tags separately.
6.  **TOPIC:** The topic for the podcast is: "${topic}"${lengthClause(targetMinutes)}

Please generate the script now.`;
  }

  if (action === 'podcastify') {
    return `You are a creative scriptwriter. Your task is to transform the following source text into an engaging, conversational podcast script in ${language}.

**VERY IMPORTANT INSTRUCTIONS:**
1.  **LANGUAGE:** The entire script, including the title, MUST be written in **${language}**.
2.  **FORMATTING:** The script MUST adhere to this strict format:
    - The very first line is the title, like "Title: [Your Engaging Podcast Title]". You should create an appropriate title based on the source text.
    - Every line of dialogue MUST start with "Speaker #:", for example, "Speaker 1:".
3.  **SPEAKERS:** You MUST write a script for exactly ${numSpeakers} speakers. Their profiles are below. The speakers should discuss and explain the concepts from the source text in a conversational manner.
${speakerProfiles}
4.  **USE NAMES IN DIALOGUE:** When speakers talk to each other, they should sometimes use each other's names (e.g., "That's a great point, ${name2}."). Use names naturally to make the conversation flow.
5.  **CONTENT:** Generate ONLY the title and dialogue. You MUST NOT include any non-speech audio cues, sound effects, or stage directions in brackets.
6.  **TRANSFORM, DON'T COPY:** Do not just assign paragraphs of the source text to speakers. You must rewrite the content into a natural, back-and-forth dialogue.${lengthClause(targetMinutes)}

**Source Text to Transform:**
"${sourceText}"

Please generate the podcast script now.`;
  }

  if (action === 'improve') {
    return `You are a script editor. Please rewrite the following podcast script to be more engaging, clear, and conversational, ensuring the final script is in ${language}.

**VERY IMPORTANT FORMATTING INSTRUCTIONS:**
1.  **LANGUAGE:** The output script MUST be in **${language}**.
2.  **MAINTAIN SCRIPT INTEGRITY:** You MUST maintain the original topic, the core message, and the number of speakers (${numSpeakers}). Their profiles are for context:
${speakerProfiles}
3.  **STRICT FORMATTING:** You MUST preserve the original script format.
    - The first line MUST be "Title: ...".
    - EVERY dialogue line MUST start with "Speaker #: ...", for example: "Speaker 1: This is my line."
    - You MUST NOT include the speaker's name after the colon. Incorrect: "Speaker 1: Olivia says...". Correct: "Speaker 1: I am saying...".
4.  **NO SOUND EFFECTS:** You MUST NOT include any non-speech audio cues, sound effects, or stage directions like [outro music] or [sound of a clock].

**Original Script:**
${script}`;
  }

  if (action === 'lengthen' && deltaSeconds != null) {
    const { estSeconds } = estimateSeconds(script);
    const { targetTotalSeconds, targetWordCount: twc } = targetWordCount(estSeconds, deltaSeconds);
    const mins = Math.floor(targetTotalSeconds / 60);
    const secs = targetTotalSeconds % 60;
    return `You are a script writer. Your task is to rewrite the provided podcast script to make it longer, aiming for a total word count of approximately ${twc} words (which translates to about ${mins}m ${secs}s). The final script must be in ${language}.

**VERY IMPORTANT FORMATTING INSTRUCTIONS:**
1.  **LANGUAGE:** The output script MUST be in **${language}**.
2.  **ACHIEVE LENGTH:** Add more conversational exchanges (more back-and-forth turns between speakers) to meet the target length. Integrate new content naturally so the script flows to a coherent conclusion.
3.  **MAINTAIN INTEGRITY:** You MUST maintain the original topic, tone, and the number of speakers (${numSpeakers}). Speaker profiles are for context:
${speakerProfiles}
4.  **STRICT FORMATTING:** You MUST preserve the exact script format.
    - The first line MUST be "Title: ...".
    - EVERY dialogue line MUST start with "Speaker #: ...", for example: "Speaker 1: This is my line."
    - You MUST NOT include the speaker's name after the colon. Incorrect: "Speaker 1: Olivia says...". Correct: "Speaker 1: I am saying...".
5.  **NO SOUND EFFECTS:** You MUST NOT include any non-speech audio cues, sound effects, or stage directions like [outro music] or [sound of a clock].

**Original Script:**
${script}`;
  }

  if (action === 'lengthen') {
    return `You are a script writer. Your task is to rewrite the provided podcast script to make it longer by adding more conversational exchanges (more back-and-forth turns between speakers). The final script must be in ${language}.

**VERY IMPORTANT FORMATTING INSTRUCTIONS:**
1.  **LANGUAGE:** The output script MUST be in **${language}**.
2.  **ADD EXCHANGES:** Increase the number of times the speakers talk to extend the dialogue. Integrate the new exchanges naturally so the script flows to a coherent conclusion.
3.  **MAINTAIN INTEGRITY:** You MUST maintain the original topic, tone, and the number of speakers (${numSpeakers}). Speaker profiles are for context:
${speakerProfiles}
4.  **STRICT FORMATTING:** You MUST preserve the exact script format.
    - The first line MUST be "Title: ...".
    - EVERY dialogue line MUST start with "Speaker #: ...", for example: "Speaker 1: This is my line."
    - You MUST NOT include the speaker's name after the colon. Incorrect: "Speaker 1: Olivia says...". Correct: "Speaker 1: I am saying...".
5.  **NO SOUND EFFECTS:** You MUST NOT include any non-speech audio cues, sound effects, or stage directions like [outro music] or [sound of a clock].

**Original Script:**
${script}`;
  }

  if (action === 'shorten') {
    const { estSeconds } = estimateSeconds(script);
    const { targetTotalSeconds, targetWordCount: twc } = targetWordCount(estSeconds, -deltaSeconds);
    const mins = Math.floor(targetTotalSeconds / 60);
    const secs = targetTotalSeconds % 60;
    return `You are a script editor. Your task is to rewrite the provided podcast script to make it SHORTER, aiming for a total word count of approximately ${twc} words (which translates to about ${mins}m ${secs}s). The final script must be in ${language}.

**VERY IMPORTANT FORMATTING INSTRUCTIONS:**
1.  **LANGUAGE:** The output script MUST be in **${language}**.
2.  **ACHIEVE LENGTH:** Remove dialogue and exchanges to meet the target length. You must be concise and ensure the script still makes sense and flows to a coherent conclusion. Prioritize removing less critical parts.
3.  **MAINTAIN INTEGRITY:** You MUST maintain the original topic, tone, and the number of speakers (${numSpeakers}). Speaker profiles are for context:
${speakerProfiles}
4.  **STRICT FORMATTING:** You MUST preserve the exact script format.
    - The first line MUST be "Title: ...".
    - EVERY dialogue line MUST start with "Speaker #: ...", for example: "Speaker 1: This is my line."
    - You MUST NOT include the speaker's name after the colon.
5.  **NO SOUND EFFECTS:** You MUST NOT include any non-speech audio cues or sound effects.

**Original Script:**
${script}`;
  }

  if (action === 'expressions') {
    const key = INTENSITY_KEYS[intensity] ?? 'Expressive';
    const intensityNote = INTENSITY_INSTRUCTIONS[key];
    return `You are a script editor specializing in audio performance. Your task is to enrich the following podcast script by adding markup tags in square brackets to control the speech synthesis. The tags and the final script must be in ${language}.

**VERY IMPORTANT INSTRUCTIONS:**
1.  **LANGUAGE:** All markup tags MUST be in **${language}** (e.g., for Italian, use "[ridendo]" not "[laughing]").
2.  **MAINTAIN SCRIPT INTEGRITY:** You MUST NOT change the original dialogue text, speaker assignments, or line order. Your ONLY job is to insert markup tags.
3.  **USE SQUARE BRACKETS:** All tags MUST be enclosed in square brackets, like \`[tag]\`. Do NOT use parentheses.
4.  **INTENSITY:** The desired performance intensity is **${key}**. ${intensityNote}
5.  **TAG TYPES (Use a mix of these):**
    *   **Non-Speech Sounds:** Insert realistic human sounds. Examples: \`[sigh]\`, \`[laughing]\`, \`[uhm]\`.
    *   **Style Modifiers:** Change the delivery of the following words. Examples: \`[shouting]\`, \`[whispering]\`, \`[sarcasm]\`, \`[robotic]\`, \`[extremely fast]\`.
    *   **Pacing & Pauses:** Control the rhythm. Examples: \`[short pause]\`, \`[medium pause]\`, \`[long pause]\`.
6.  **STRATEGIC PLACEMENT:** Place tags where they will be most effective. They can be placed at the start or in the middle of a sentence for better timing. For example: "Speaker 1: And the answer is... [long pause] ... nothing."
7.  **SPEAKER CONTEXT:** The script is for ${numSpeakers} speakers. Their profiles are for your context only:
${speakerProfiles}
8.  **STRICT FORMATTING:** Preserve the exact script formatting ("Title: ...", "Speaker #: ...").

**Original Script:**
${script}`;
  }

  if (action === 'translate') {
    const lang = targetLanguage;
    return `You are a professional translator and script editor. Your task is to translate the following podcast script into **${lang}**.

**VERY IMPORTANT FORMATTING INSTRUCTIONS:**
1.  **TARGET LANGUAGE:** Translate the dialogue content into **${lang}**. Ensure the translation is natural and conversational.
2.  **PRESERVE SPEAKER TAGS:** You MUST PRESERVE the exact format 'Speaker #: ' at the start of every line. Do not translate the word 'Speaker' or the numbers. Only translate the text that follows the colon.
    - Correct: "Speaker 1: [Translated text in ${lang}]"
    - Incorrect: "Oratore 1: [Translated text]"
    - Incorrect: "Speaker One: [Translated text]"
3.  **MAINTAIN MEANING & TONE:** Keep the original meaning, tone, and context of the conversation.
4.  **SPEAKER CONTEXT:** The script is for ${numSpeakers} speakers. Their profiles are for context:
${speakerProfiles}
5.  **MARKUP TAGS:** If there are existing expression tags (like [laughing]), translate the tag content into ${lang} as well (e.g., [ridendo]).

**Original Script:**
${script}`;
  }

  throw new Error(`unknown action ${action}`);
}
