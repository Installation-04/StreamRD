/** Browsers play a narrow set of containers and codecs, and this app never transcodes. */
export interface PlaybackAdvice { risky: boolean; reasons: string[] }

const CONTAINER = /\.(mkv|avi|wmv|flv|ts|m2ts|mts|divx|rmvb)(?:$|[?#])/i;
const AUDIO = /(?:^|[^a-z0-9])(dts(?:[-. ]?(?:hd|x|ma))?|truehd|atmos|e[-. ]?ac-?3|eac3|ac-?3|dd(?:p|\+)?[ .]?[257]\.[01])(?:$|[^a-z0-9])/i;
const VIDEO = /(?:^|[^a-z0-9])(hevc|x265|h[. ]?265|av1|vc-?1|xvid|10-?bit|hi10p?)(?:$|[^a-z0-9])/i;

export function playbackAdvice(filename: string | undefined, mimeType?: string): PlaybackAdvice {
  const name = filename ?? "", reasons: string[] = [];
  const mkv = /matroska/i.test(mimeType ?? "") || /\.mkv(?:$|[?#])/i.test(name);
  if (mkv) reasons.push("an MKV container, which Firefox and Safari cannot open and Chrome-based browsers only sometimes can");
  else if (CONTAINER.test(name)) reasons.push("a container most browsers cannot open");
  const audio = AUDIO.exec(name)?.[1];
  if (audio) reasons.push(`${audio.toUpperCase().replace(/[-. ]/g, "")} audio, which browsers generally cannot decode`);
  const video = VIDEO.exec(name)?.[1];
  if (video) reasons.push(`${video.toUpperCase()} video, which many browsers cannot decode`);
  return { risky: reasons.length > 0, reasons };
}

/** A <source type> the browser rejects is skipped silently, so never pass Matroska types. */
export function sourceType(mimeType: string | undefined): string | undefined {
  return mimeType && !/matroska/i.test(mimeType) ? mimeType : undefined;
}
