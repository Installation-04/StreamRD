# Synthetic playback fixture

`account-video.mp4` is an original one-second, silent blue rectangle generated
for local account-library browser tests. It contains no film or provider media.
It is fulfilled by Playwright for an example.invalid URL; no real debrid download
or playback is claimed. Its size is 1,682 bytes in the protocol fixture.

Regenerate with FFmpeg and libx264:

```bash
ffmpeg -f lavfi -i color=c=0x264460:s=160x90:r=10:d=1 -an -c:v libx264 -profile:v baseline -pix_fmt yuv420p -movflags +faststart account-video.mp4
```

The fixture is provided under the repository's MIT license.
