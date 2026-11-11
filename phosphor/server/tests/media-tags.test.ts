import { expect, it } from "vitest";
import { mediaTags } from "../src/media-tags";

const labels = (release: string | null) => mediaTags(release).map(tag => `${tag.kind}:${tag.label}`);

it("reads resolution, source, video, audio and container from a release name", () => {
  expect(labels("Crank 2006 Director's Cut 1080p BluRay DTS x264-CtrlHD.mkv")).toEqual(["resolution:1080p", "source:BluRay", "video:H.264", "audio:DTS", "container:MKV"]);
  expect(labels("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10+.HEVC-GROUP")).toEqual(["resolution:4K", "source:WEB", "video:HEVC", "audio:Atmos", "audio:EAC3", "hdr:Dolby Vision", "hdr:HDR10+"]);
  expect(labels("Show S01E01 720p HDTV x264 AAC.mp4")).toEqual(["resolution:720p", "source:HDTV", "video:H.264", "audio:AAC", "container:MP4"]);
});
it("names the most specific audio format and does not double count", () => {
  expect(labels("Film 1080p Remux AVC DTS-HD MA 7.1")).toEqual(["resolution:1080p", "source:Remux", "video:H.264", "audio:DTS-HD"]);
  expect(labels("Film 1080p BluRay TrueHD Atmos x265 10bit")).toEqual(["resolution:1080p", "source:BluRay", "video:HEVC", "video:10-bit", "audio:TrueHD", "audio:Atmos"]);
});
it("says nothing when the name says nothing, and never matches inside words", () => {
  expect(mediaTags(null)).toEqual([]);
  expect(mediaTags("The Dvd Collection of Stories")).toEqual([{ kind: "source", label: "DVD" }]);
  expect(labels("Attitude Maximum Webster")).toEqual([]);
  expect(labels("Movie 4K UHD")).toEqual(["resolution:4K"]);
});
