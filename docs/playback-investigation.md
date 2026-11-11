# Converted playback that fails in the browser: investigation

Applies to v0.23.1. Fixed in v0.23.2. This page records what was tested, what was found and what remains open, so that later work on playback starts from evidence.

## The report
An MKV with H.264 video and DTS audio is converted by the server (the picture copied, the audio turned into AAC), yet the `<video>` element fails. The server logs no error and the player's "What the server says" is empty.

## How it was tested
The server's real stream route (`server/src/routes/stream.ts`, `server/src/transcode.ts`) was run against files served over HTTP with range support, and played in Google Chrome 153 (Linux, software decoding) by a page that uses the player's markup: `<video autoplay playsinline preload="metadata">` with a `<source type="video/mp4">`. Each file was generated with ffmpeg; none is a real release.

| File | Start | Result in Chrome |
|---|---|---|
| H.264 High, 2 s closed GOPs, DTS 5.1 | 0 s and 12 s | plays |
| 1080p, 25 Mbit/s, 10 s **open** GOPs, DTS 5.1 | 0 s and 5 s | plays (both start on the first frame) |
| the same file | 40 s | **fails**: `MEDIA_ERR_DECODE`, `PIPELINE_ERROR_DECODE: Failed to send video packet for decoding` |
| the same content with **closed** GOPs | 40 s | plays |
| the open-GOP file with the picture re-encoded | 40 s | plays |
| two audio tracks and a subtitle track | 0 s | plays |
| interlaced H.264 | 0 s | plays |
| H.264 4:2:2 and 4:4:4, 8-bit | 0 s | plays |
| H.264 remuxed from MPEG-TS | 0 s | plays |
| paused 40 s through the single-container gateway | — | plays on |

## Cause
`-ss` before `-i` with `-c:v copy` starts the output at the keyframe before the requested time. Matroska marks every recovery-point I-frame as a keyframe, but in an open-GOP stream such a frame is not an IDR frame: pictures after it may still refer to, or issue memory-management commands about, pictures before it. Those pictures are not in the output.

ffmpeg's decoder reports this as `mmco: unref short failure` and carries on, as desktop players do. Chrome decodes with error detection set to fail, so the same packet ends playback. `ffmpeg -err_detect explode -xerror` gave the same verdict as Chrome on every stream where both were run, which gives the test suite a browser-strict decoder without a browser.

Why it matched the report so poorly until now:
- it never happens from the first frame, so a title "plays" until it is resumed (the player resumes anything past 5 seconds) or sought;
- it depends on the encoder's settings. of six open-GOP encodes made with different encoder settings, three failed and three played;
- ffmpeg exits normally, so the server had no error to pass on.

Dropping the leading frames (`-bsf:v noise=drop=…`) does not help: the failing packets come later in the group.

## Fix in v0.23.2
1. The player listens for a decode error on a converted stream whose picture was copied. It asks for the same stream id with `video=1` from the current position, once, and keeps that for the rest of the video.
2. The server re-encodes the picture for that request (the existing `video` mode) and writes a *playback* log entry. With `TRANSCODE_VIDEO=false` it answers 409 with the reason.
3. The player also listens on the `<source>` element. A refused stream (404, 502, 503) raises its error there and never on `<video>`, so those failures used to show nothing.

The fallback is driven by the browser on purpose. The browser is the only party that knows what its decoder accepts: software and hardware decoders differ, and so do browsers. A check on the server before every seek would add a second connection to the provider and a delay to every seek on every file, to guess at the same answer.

## Tests added
- `server/tests/transcode.test.ts`: an open-GOP fixture; strict decoding passes from the start, fails from the middle when copied, passes from the middle with `video=1`; the log entry has no link; 409 with `TRANSCODE_VIDEO=false`; `video=yes` is rejected.
- `qa/converted-playback.cjs`: the same cases in Google Chrome against the real route, plus the `<source>` error. Runs in CI on the runner's Chrome.
- CI installs ffmpeg in the server job. Without it every real-ffmpeg test skipped itself.

## Still open
- The original file has not been played on the fix.
- Not run: Chrome with hardware decoding, Firefox, Safari, Edge.
- Re-encoding is the expensive answer. Segment-based delivery, planned next, can start each seek on a segment boundary and re-encode only the first group of pictures.
- Other reasons a converted stream may fail were looked for and not found in these files; they are not excluded for real releases (damaged streams, unusual profiles, links that expire mid-stream).
