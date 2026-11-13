/**
 * Which episode a video file is, from its name: "Show.S02E05.1080p.mkv" or "Show 2x05". Used to lay the videos of a season pack out by season
 * and episode, the way a media server does, instead of as one long list of file names.
 */
export interface EpisodeId { season: number; episode: number }
export function episodeOf(name: string): EpisodeId | null {
  const base = name.replace(/^[\\/]+/, "").split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? name;
  const found = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i.exec(base) ?? /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(base);
  return found ? { season: Number(found[1]), episode: Number(found[2]) } : null;
}
export interface SeasonGroup<T> { season: number; items: Array<{ file: T; episode: number }> }
/** The files by season and episode, or null when fewer than two of them are episodes (then a plain list is the right way to show them). */
export function groupEpisodes<T extends { name: string }>(files: T[]): { seasons: Array<SeasonGroup<T>>; others: T[] } | null {
  const seasons = new Map<number, SeasonGroup<T>>(), others: T[] = []; let count = 0;
  for (const file of files) {
    const id = episodeOf(file.name);
    if (!id) { others.push(file); continue; }
    count++;
    const group = seasons.get(id.season) ?? { season: id.season, items: [] }; group.items.push({ file, episode: id.episode }); seasons.set(id.season, group);
  }
  if (count < 2) return null;
  const list = [...seasons.values()].sort((a, b) => a.season - b.season);
  for (const group of list) group.items.sort((a, b) => a.episode - b.episode || a.file.name.localeCompare(b.file.name));
  return { seasons: list, others };
}
