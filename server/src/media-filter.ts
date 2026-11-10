/**
 * Debrid accounts hold everything people ever added: games, software, music, books. StreamRD's library is for
 * movies and shows, so imports pass through this filter. It only uses the title text, never the network, and
 * it errs toward keeping a title (a wrongly skipped movie is worse than a stray extra).
 */
export type MediaVerdict = { keep: true } | { keep: false; reason: "game" | "software" | "music" | "book" | "unreadable" | "file" };

// Resolution, codec and source tags appear on real movie/TV releases and almost never on anything else.
const VIDEO_TAGS = /(?:^|[^a-z0-9])(?:480p|576p|720p|1080[pi]|2160p|4k|uhd|blu-?ray|bdrip|brrip|dvdrip|web-?dl|web-?rip|hdtv|hdrip|remux|x26[45]|h[ .]?26[45]|hevc|xvid|s\d{1,3}e\d{1,4})(?:[^a-z0-9]|$)/i;
const GAME = /(?:^|[^a-z0-9])(?:xbox(?:[ ._-]?(?:360|one|series(?:[ ._-]?[xs])?))?|ps[ ._-]?[1-5]|ps(?:one|vita)|playstation(?:[ ._-]?[1-5])?|nintendo|nsw|wii(?:[ ._-]?u)?|3ds|nds|psp|gamecube|dreamcast|steam(?:[ ._-]?rip)?|gog|fitgirl|dodi[ ._-]?repack|elamigos|skidrow|codex|cpy|tenoke|razor1911|goldberg|trainer|dlcs?|roms?|pc[ ._-]?games?|games?[ ._-]?(?:collection|pack|bundle|library)|for[ ._-]?(?:pc|windows)|walkthrough)(?:[^a-z0-9]|$)/i;
const SOFTWARE = /(?:^|[^a-z0-9])(?:adobe|photoshop|illustrator|premiere|after[ ._-]?effects|autocad|office[ ._-]?(?:365|20\d\d)|windows[ ._-]?(?:7|8|10|11|server)|macos|mac[ ._-]?os[ ._-]?x|ubuntu|linux|keygen|cracked?|activator|patch(?:ed)?|portable|software|installer|setup|vst3?|ableton|fl[ ._-]?studio|nulled|apk|msi|x64[ ._-]?x86|sfx|plugins?)(?:[^a-z0-9]|$)/i;
const MUSIC = /(?:^|[^a-z0-9])(?:discography|discografia|mp3|320[ ._-]?kbps|album|flac[ ._-]?(?:16|24)|lossless)(?:[^a-z0-9]|$)/i;
const BOOK = /(?:^|[^a-z0-9])(?:e-?books?|epub|mobi|cbz|cbr|comics?|audiobooks?|udemy|coursera|skillshare|masterclass|tutorials?|courses?)(?:[^a-z0-9]|$)/i;
const FILE = /\.(?:zip|rar|7z|tar|gz|apk|msi|pkg|exe|dmg|bin|nfo|txt|srt|ass|sub|ssa|vtt|pdf|epub|mobi|mp3|flac|wav|ogg|aac|jpe?g|png|webp|gif)$/i;
// A bare info-hash (or hash plus site tag) names nothing; there is no title to match.
const UNREADABLE = /^[\[(]?[a-f0-9]{32,40}[\])]?(?:[ ._\[(-]|$)/i;

export function classifyTitle(original: string): MediaVerdict {
  const name = original.replace(/\s+/g, " ").trim();
  if (FILE.test(name)) return { keep: false, reason: "file" };
  if (UNREADABLE.test(name)) return { keep: false, reason: "unreadable" };
  if (VIDEO_TAGS.test(name)) return { keep: true };
  if (GAME.test(name)) return { keep: false, reason: "game" };
  if (SOFTWARE.test(name)) return { keep: false, reason: "software" };
  if (MUSIC.test(name)) return { keep: false, reason: "music" };
  if (BOOK.test(name)) return { keep: false, reason: "book" };
  return { keep: true };
}
