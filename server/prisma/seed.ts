/**
 * Seeds a demo catalog so a fresh install has something to browse.
 * Run with: npm run db:seed
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const demoTitles = [
  {
    name: "Big Buck Bunny",
    description:
      "A giant rabbit takes revenge on three bullying rodents. Open movie by the Blender Foundation — royalty-free demo content.",
    type: "movie",
    genres: JSON.stringify(["Animation", "Comedy"]),
    year: 2008,
    posterUrl: null,
    backdropUrl: null,
    // Direct-hosted open content; replace with your own debrid-backed sources.
    sources: JSON.stringify([
      {
        kind: "link",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
        quality: "1080p",
        label: "Blender Foundation mirror",
      },
    ]),
  },
  {
    name: "Sintel",
    description:
      "A lonely girl searches for the dragon she once befriended. Open movie by the Blender Foundation.",
    type: "movie",
    genres: JSON.stringify(["Animation", "Fantasy"]),
    year: 2010,
    posterUrl: null,
    backdropUrl: null,
    sources: JSON.stringify([
      {
        kind: "link",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
        quality: "1080p",
        label: "Blender Foundation mirror",
      },
    ]),
  },
];

async function main() {
  for (const title of demoTitles) {
    const existing = await db.title.findFirst({ where: { name: title.name } });
    if (!existing) await db.title.create({ data: title });
  }
  // eslint-disable-next-line no-console
  console.log("Seed complete.");
}

main().finally(() => db.$disconnect());
