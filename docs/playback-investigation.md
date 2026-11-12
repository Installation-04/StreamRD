# Converted playback that failed in the browser: investigation

Applies to v0.22.0 to v0.23.1. Fixed in v0.23.2. This page records what was tested, what was found and what remains open, so that later
work on playback starts from evidence.

## The report
An MKV with H.264 video and DTS audio is converted by the server (the picture copied, the audio turned into AAC), yet the `<video>`
element fails. The server logs no error and the player's "What the server says" is empty.

## Two causes, found in this order

### 1. The player started every converted video over, without end (the cause of the report)
Found by running the whole product (the real API, web app and gateway) against a stand-in debrid account and playing through the real
player page in Google Chrome. See [the local lab](../qa/README.md#the-local-lab).

The player page has an effect that opens the title and starts playback. Among its dependencies was the function that saves viewing
progress, and that function was rebuilt whenever the playback state changed. A file that plays as it is never changes that state. A
**converted** stream does: when it arrives, the function is rebuilt, the effect runs again, the title is opened again, playback is
requested again, the new answer replaces the stream, and so on. In the lab the player asked the server to play the same title dozens of
times in a few seconds. Each request registered a new stream and started ffmpeg; the conversion limit answered 503 and the play route's
rate limit then answered "Too many requests, try again later".

So every converted file failed in the web player, whatever its codecs. Files that play directly were not affected, which is why the
existing browser journeys (an MP4 fixture, in a browser without H.264 or AAC decoders) never saw it. v0.23.1's observation that "a
browser often asks for one video several times" was this loop seen from the server.

With the dependency restored on purpose, the journey fails at the first converted file with the same message a viewer saw:
*We couldn't start this video. Too many requests, try again later.*

**Fix.** The effect reaches the progress function through a ref, so it runs once per title.

### 2. A copied picture that cannot be decoded from where the stream starts
Found first, by driving the server's stream route directly from a page that used the player's markup. It is real, but it only shows once
cause 1 is out of the way, and only after a resume or a seek.

`-ss` before `-i` with `-c:v copy` starts the output at the keyframe before the requested time. Matroska marks every recovery-point
I-frame as a keyframe, but in an open-GOP stream (Blu-ray style encodes) such a frame is not an IDR frame: pictures after it may still
refer to, or issue memory-management commands about, pictures before it. Those pictures are not in the output. ffmpeg's decoder reports
`mmco: unref short failure` and carries on, as desktop players do. Chrome decodes with error detection set to fail, so the same packet
ends playback with `PIPELINE_ERROR_DECODE`. `ffmpeg -err_detect explode -xerror` gave the same verdict as Chrome on every stream where
both were run, which gives the test suite a browser-strict decoder without a browser.

| File (all generated with ffmpeg; none is a real release) | Start | Result in Chrome 153, software decoding |
|---|---|---|
| H.264 High, 2 s closed GOPs, DTS 5.1 | 0 s and 12 s | plays |
| 1080p, 25 Mbit/s, 10 s **open** GOPs, DTS 5.1 | 0 s and 5 s | plays (both start on the first frame) |
| the same file | 40 s | **fails**: `MEDIA_ERR_DECODE` |
| the same content with **closed** GOPs | 40 s | plays |
| the open-GOP file with the picture re-encoded | 40 s | plays |
| two audio tracks and a subtitle track; interlaced; 4:2:2 and 4:4:4 8-bit; remuxed from MPEG-TS | 0 s | plays |

It depends on the encoder's settings: of six open-GOP encodes, three failed and three played. Dropping the leading frames
(`-bsf:v noise=drop=…`) does not help; the failing packets come later in the group.

**Fix.** The player listens for a decode error on a converted stream whose picture was copied, asks for the same stream id with
`video=1` from the current position, once, and keeps that for the rest of the video. The server re-encodes the picture for that request
and logs it; with `TRANSCODE_VIDEO=false` it answers 409 with the reason. The fallback is driven by the browser on purpose: only the
browser knows what its decoder accepts, and a check on the server before every seek would delay every seek on every file.

## Other faults found on the way
- **A refused stream showed nothing.** A 404, 502 or 503 on a converted stream raises its error on the `<source>` element and never on
  `<video>`, where the player listened. It now listens on both.
- **A warning over a video that was playing.** "This file may not play in your browser… the server converted it but it still could not
  be played" was shown during normal playback of a converted stream. It is now shown only when playback fails, or for a file played as it is.
- **A quick click on the seek bar could be lost**, and every arrow-key press restarted the conversion. The chosen position is now kept
  outside React state and sent once: at the end of a drag, or a moment after the last key press.
- **Keyboard shortcuts stopped after a click on the seek bar**, because the focus was on an input. Space, Esc, F, M, J, L and N work there now.
- **Titles were left out on import** when their release name ended in an audio codec (`…WEB-DL.H264.AAC`, `…XviD.MP3`,
  `…x264.FLAC`): the name was taken for an audio file. Two separate checks did this.

## Tests
- `qa/lab/journey.cjs`: the owner's journey in Google Chrome against the lab. It plays an MP4, an MKV with DTS (asserting that playback
  is requested exactly once), seeks in it (asserting the fallback), resumes, plays HEVC 10-bit with TrueHD and Xvid in AVI, a title still
  downloading, and a season pack through Up next. Runs in CI.
- `server/tests/transcode.test.ts`: an open-GOP fixture; strict decoding passes from the start, fails from the middle when copied,
  passes from the middle with `video=1`; the refusal when picture conversion is off; a log line for each play.
- `qa/converted-playback.cjs`: the stream route alone in Google Chrome.
- `server/tests/media-filter.test.ts`: the import cases above.
- CI installs ffmpeg in the server job. Without it every real-ffmpeg test skipped itself.

## Still open
- The original file has not been played on the fix. Cause 1 applied to every converted file, so it applied to that one.
- Not run: Chrome with hardware decoding, Firefox, Safari, Edge.
- Re-encoding is the expensive answer to cause 2. Segment-based delivery, planned next, can start each seek on a segment boundary and
  re-encode only the first group of pictures.
- A converted stream held paused for 40 seconds through the gateway kept playing; longer pauses were not tried.
