/**
 * Plays the server's converted stream through the browser's own streaming API (Media Source Extensions), which Chrome, Firefox and Safari
 * on a computer or an iPad all have. The stream is an ordinary fragmented MP4 that the server cuts from a keyframe; this reads it and
 * hands it to the player in order, so that:
 *  - the video has a real length and a real buffer (what is loaded is what the browser's own bar shows),
 *  - a skip inside what is loaded needs nothing, and a skip outside it opens a new stream at that second and adds it to the buffer,
 *  - the picture and the sound of a stream start together, so the sound follows after a skip,
 *  - the browser says when it is waiting for data, instead of freezing.
 * A browser without it (an iPhone, before iOS 17.1) or a stream whose codecs it cannot play falls back to the plain `<video src>` path.
 */
export type MseProblem = "unsupported" | "network";
export interface MseOptions {
  video: HTMLVideoElement;
  /** The stream route, opened from this second (the server cuts at the keyframe at or before it). `forceVideo` asks for the picture to be re-encoded. */
  streamUrl: (start: number, forceVideo: boolean) => string;
  /** Where the stream asked to start at this second really starts (the keyframe). */
  startUrl: (at: number, forceVideo: boolean) => string;
  /** The video's length in seconds. */
  duration: number;
  /** Where playback begins. */
  initial: number;
  forceVideo: boolean;
  onProblem: (kind: MseProblem, message: string) => void;
}
export interface MsePlayback { destroy: () => void }

// Seconds kept loaded ahead of the picture, and the most bytes that may be: Firefox allows about 100 MB for a video, and a Blu-ray rip is 10 MB a second.
const AHEAD_START = 90, AHEAD_BYTES = 48 * 1024 * 1024, BEHIND_KEEP = 40, BATCH = 192 * 1024, SLICE = 1024 * 1024;

export function mseSupported(): boolean {
  try { return typeof window !== "undefined" && typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && typeof ReadableStream !== "undefined" && Boolean(window.fetch); } catch { return false; }
}

// ---- A small reader for the boxes of an MP4 file: just enough to find the codecs in its header.
interface Box { type: string; start: number; end: number; body: number }
function boxes(data: Uint8Array, from = 0, to = data.length): Box[] {
  const out: Box[] = [], view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at), body = at + 8;
    const type = String.fromCharCode(data[at + 4], data[at + 5], data[at + 6], data[at + 7]);
    if (size === 1 && at + 16 <= to) { size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12); body = at + 16; }
    else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, end: at + size, body }); at += size;
  }
  return out;
}
const child = (data: Uint8Array, box: Box, type: string, skip = 0) => boxes(data, box.body + skip, box.end).find(entry => entry.type === type);
const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

/** The MIME type, with codecs, of what a fragmented MP4 header declares; null when it is not something every browser plays (H.264 with AAC, MP3 or Opus). */
export function codecsOf(init: Uint8Array): string | null {
  const moov = boxes(init).find(box => box.type === "moov"); if (!moov) return null;
  const found: string[] = [];
  for (const trak of boxes(init, moov.body, moov.end).filter(box => box.type === "trak")) {
    const mdia = child(init, trak, "mdia"), minf = mdia && child(init, mdia, "minf"), stbl = minf && child(init, minf, "stbl"), stsd = stbl && child(init, stbl, "stsd");
    if (!stsd) continue;
    const entry = boxes(init, stsd.body + 8, stsd.end)[0]; if (!entry) continue;   // 4 bytes version and flags, 4 bytes entry count
    if (entry.type === "avc1" || entry.type === "avc3") {
      const avcC = child(init, entry, "avcC", 78); if (!avcC) return null;
      found.push(`${entry.type}.${hex(init[avcC.body + 1])}${hex(init[avcC.body + 2])}${hex(init[avcC.body + 3])}`);
    } else if (entry.type === "mp4a") {
      const esds = child(init, entry, "esds", 28); let code = "mp4a.40.2";
      if (esds) {
        // esds: version and flags, then descriptors: 0x03 (ES), inside it 0x04 (decoder config: object type first) and 0x05 (specific info: audio object type in its first 5 bits).
        let at = esds.body + 4; const tag = () => { const kind = init[at++]; let size = 0; for (let i = 0; i < 4; i++) { const byte = init[at++]; size = (size << 7) | (byte & 0x7f); if (!(byte & 0x80)) break; } return { kind, size }; };
        let descriptor = tag(); if (descriptor.kind === 0x03) { at += 3; descriptor = tag(); }
        if (descriptor.kind === 0x04) {
          const objectType = init[at]; at += 13; const specific = tag();
          if (objectType === 0x40 && specific.kind === 0x05) code = `mp4a.40.${init[at] >> 3}`;
          else if (objectType !== 0x40) code = `mp4a.${hex(objectType)}`;
        }
      }
      found.push(code);
    } else if (entry.type === "Opus") found.push("opus");
    else return null;   // another codec: the plain path decides
  }
  return found.length ? `video/mp4; codecs="${found.join(",")}"` : null;
}

export function startMse(options: MseOptions): MsePlayback {
  const { video } = options, mediaSource = new MediaSource(), url = URL.createObjectURL(mediaSource);
  let buffer: SourceBuffer | null = null, mime = "", generation = 0, controller: AbortController | null = null, destroyed = false;
  // How many seconds ahead of the picture are kept loaded. It shrinks when the browser says its memory for this video is full: Firefox allows
  // far less than Chrome (about 100 MB for the picture), and a Blu-ray rip at 90 seconds ahead is more than that.
  let aheadMax = AHEAD_START, appended = 0;   // appended: bytes handed to the browser since the stream being read was opened
  // The stream being read: where it starts and the second it was opened for. A skip to what it is about to deliver needs no new stream.
  let loading: { from: number; target: number } | null = null;
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const quiet = () => destroyed;
  const ranges = () => { const list: Array<[number, number]> = []; try { for (let i = 0; i < video.buffered.length; i++) list.push([video.buffered.start(i), video.buffered.end(i)]); } catch { /* not attached */ } return list; };
  const idle = async () => { while (buffer && buffer.updating && !quiet()) await new Promise<void>(done => buffer!.addEventListener("updateend", () => done(), { once: true })); };
  const loadedAhead = () => { const at = video.currentTime; return ranges().filter(([from, to]) => from <= at + 1 && to > at).map(([, to]) => to - at)[0] ?? 0; };
  /** Lets go of what is not needed to play on: what has been watched, or, when the picture is waiting for data, what is loaded somewhere else. True when something was freed. */
  async function freeRoom(): Promise<boolean> {
    if (!buffer) return false;
    const at = video.currentTime; let freed = false;
    for (const [from, to] of ranges()) {
      const end = Math.min(to, at - 2);
      if (end - from > 0.5) { await idle(); try { buffer.remove(from, end); freed = true; } catch { /* try again */ } await idle(); }
    }
    if (!freed && loadedAhead() === 0) {
      for (const [from, to] of ranges()) if (from > at + 0.5) { await idle(); try { buffer.remove(from, to); freed = true; } catch { /* try again */ } await idle(); }
    }
    return freed;
  }
  /**
   * Hands bytes to the browser a megabyte at a time. A read of the network stream can return everything that piled up while the page was
   * busy (Firefox returned 50 MB in one read of a Blu-ray rip), and a single append larger than the browser's whole allowance for this video
   * can never fit, however much room is made.
   */
  async function append(bytes: Uint8Array, gen: number) {
    for (let at = 0; at < bytes.length; at += SLICE) {
      if (quiet() || gen !== generation) return;
      if (at > 0) await room(gen);
      await appendSlice(bytes.subarray(at, Math.min(bytes.length, at + SLICE)), gen);
    }
  }
  async function appendSlice(bytes: Uint8Array, gen: number) {
    if (!buffer || quiet() || gen !== generation) return;
    await idle();
    if (quiet() || gen !== generation) return;
    // A full buffer is not a failure: it is the browser asking for the picture to catch up. Make room, keep fewer seconds ahead from now on,
    // and try again until it fits. Only a picture that has not moved for a minute while it should be playing is given up on.
    let lastAt = video.currentTime, lastMoved = Date.now();
    for (;;) {
      try { buffer.appendBuffer(bytes as BufferSource); await idle(); appended += bytes.length; return; }
      catch (error) {
        if ((error as DOMException).name !== "QuotaExceededError") throw error;
        if (quiet() || gen !== generation) return;
        if (await freeRoom()) continue;
        aheadMax = Math.max(8, Math.min(aheadMax, Math.floor(loadedAhead() * 0.7)));
        await sleep(400);
        if (Math.abs(video.currentTime - lastAt) > 0.01) { lastAt = video.currentTime; lastMoved = Date.now(); }
        else if (video.paused || video.seeking) lastMoved = Date.now();
        else if (Date.now() - lastMoved > 60_000) throw new Error("The browser has no room for more of this video.");
      }
    }
  }
  /** Keeps the buffer to what is useful: a minute and a half ahead of the picture, forty seconds behind it. */
  async function room(gen: number) {
    for (;;) {
      if (quiet() || gen !== generation) return;
      const at = video.currentTime, list = ranges(), ahead = list.filter(([from, to]) => from <= at + 1 && to > at).map(([, to]) => to - at)[0] ?? 0;
      // How many seconds fit in the byte allowance, from how big this video's seconds have turned out to be.
      const seconds = loading && list.length ? list[list.length - 1][1] - loading.from : 0, perSecond = seconds >= 3 ? appended / seconds : 0;
      if (ahead < Math.min(aheadMax, perSecond > 0 ? Math.max(6, AHEAD_BYTES / perSecond) : aheadMax)) break;
      await sleep(500);
    }
    const old = ranges()[0]; if (buffer && old && old[1] < video.currentTime - BEHIND_KEEP) { await idle(); try { buffer.remove(old[0], Math.min(old[1], video.currentTime - BEHIND_KEEP)); } catch { /* it is only tidying */ } }
  }

  async function begin(target: number, force: boolean) {
    const gen = ++generation; controller?.abort(); const mine = controller = new AbortController();
    let start = target;
    try { const answer = await fetch(options.startUrl(target, force), { credentials: "include", signal: mine.signal }); if (answer.ok) { const value = (await answer.json() as { start?: number }).start; if (typeof value === "number" && value >= 0 && value <= target + 0.001) start = value; } } catch { if (mine.signal.aborted) return; }
    if (quiet() || gen !== generation) return;
    loading = { from: start, target }; appended = 0;
    let response: Response;
    try { response = await fetch(options.streamUrl(target, force), { credentials: "include", signal: mine.signal }); } catch { if (!mine.signal.aborted) options.onProblem("network", "The video stream could not be reached."); return; }
    if (!response.ok || !response.body) { let message = "The server could not start this video."; try { message = ((await response.json()) as { error?: string }).error ?? message; } catch { /* keep the default */ } if (gen === generation) options.onProblem("network", message); return; }
    const reader = response.body.getReader();
    let held = new Uint8Array(0), initEnd = 0, batch: Uint8Array[] = [], batchSize = 0;
    const join = (parts: Uint8Array[], size: number) => { const out = new Uint8Array(size); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (quiet() || gen !== generation) { void reader.cancel().catch(() => undefined); return; }
        if (value) { if (!initEnd) { const next = new Uint8Array(held.length + value.length); next.set(held); next.set(value, held.length); held = next; } else { batch.push(value); batchSize += value.length; } }
        if (!initEnd) {
          // The header is done once its movie box is whole.
          const list = boxes(held), moov = list.find(box => box.type === "moov");
          if (moov) {
            initEnd = moov.end; const code = codecsOf(held.subarray(0, initEnd));
            if (!code || !MediaSource.isTypeSupported(code)) { void reader.cancel().catch(() => undefined); options.onProblem("unsupported", "This browser cannot play this video's format through its streaming API."); return; }
            if (!buffer) { buffer = mediaSource.addSourceBuffer(code); mime = code; buffer.mode = "segments"; buffer.addEventListener("error", () => options.onProblem("unsupported", "The browser refused this video's data.")); }
            else if (code !== mime) { if (typeof buffer.changeType !== "function") { options.onProblem("unsupported", "This browser cannot change a video's format part-way."); return; } await idle(); buffer.changeType(code); mime = code; }
            await idle(); try { buffer.abort(); } catch { /* it was not mid-segment */ }
            buffer.timestampOffset = start;
            await append(held.subarray(0, initEnd), gen);
            if (Math.abs(video.currentTime - target) > 0.5) { try { video.currentTime = target; } catch { /* set again when metadata is known */ } }
            if (held.length > initEnd) { const rest = held.subarray(initEnd); batch.push(rest); batchSize += rest.length; }
            held = new Uint8Array(0);
          }
        }
        if (initEnd && (batchSize >= BATCH || done) && batchSize > 0) { await room(gen); if (quiet() || gen !== generation) return; await append(join(batch, batchSize), gen); batch = []; batchSize = 0; }
        if (done) break;
      }
      if (gen === generation && !quiet()) { loading = null; await idle(); if (mediaSource.readyState === "open") { try { mediaSource.endOfStream(); } catch { /* already ended */ } } }
    } catch (error) {
      if (mine.signal.aborted || quiet() || gen !== generation) return;
      loading = null;
      options.onProblem("network", error instanceof Error ? error.message : "The video stream stopped.");
    }
  }
  // A skip to a second that is not loaded opens the stream at that second; one that is loaded, or about to be, needs nothing.
  const onSeeking = () => {
    if (!buffer || destroyed) return;
    const at = video.currentTime, list = ranges();
    if (list.some(([from, to]) => at >= from - 0.05 && at <= to + 0.05)) return;
    // The stream being read will get there: it was opened for this second (setting the position ourselves raises this event too), or it is about to reach it.
    if (loading && controller && !controller.signal.aborted && (Math.abs(at - loading.target) < 1 || (at >= loading.from - 0.05 && at <= Math.max(loading.from, ...list.map(([, to]) => to)) + 8))) return;
    void begin(at, options.forceVideo);
  };
  video.addEventListener("seeking", onSeeking);
  // A browser short of memory can let go of the data under the picture itself (Firefox did, keeping what came after): the picture then waits
  // in a hole for data that is already behind the stream being read. When that has lasted a few seconds, the stream is opened again at the picture.
  let stuckSince = 0;
  const watch = setInterval(() => {
    if (!buffer || destroyed || video.paused || video.ended || video.seeking) { stuckSince = 0; return; }
    const at = video.currentTime, list = ranges();
    if (list.some(([from, to]) => at >= from - 0.05 && at <= to + 0.05) || !list.some(([from]) => from > at + 0.05)) { stuckSince = 0; return; }
    stuckSince = stuckSince || Date.now();
    if (Date.now() - stuckSince > 3000) { stuckSince = 0; void begin(at, options.forceVideo); }
  }, 1000);
  mediaSource.addEventListener("sourceopen", () => {
    if (destroyed || mediaSource.readyState !== "open") return;
    if (options.duration > 0) { try { mediaSource.duration = options.duration; } catch { /* set when a buffer exists */ } }
    void begin(options.initial, options.forceVideo);
  }, { once: true });
  video.src = url;
  return { destroy() {
    destroyed = true; loading = null; controller?.abort(); video.removeEventListener("seeking", onSeeking); clearInterval(watch);
    try { video.removeAttribute("src"); video.load(); } catch { /* the page is going away */ }
    URL.revokeObjectURL(url);
  } };
}
