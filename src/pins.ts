import type { BinaryProps } from "./release.ts";

export const weedBinary = (path: string): BinaryProps => ({
  asset: {
    format: "tar.gz",
    member: "weed",
    memberSha256: "8c07a1ccc4ec058cd90989ac0533c30436832e41c63de2b26f37253d9f744c4d",
  },
  path,
  sha256: "4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124",
  size: 46_067_365,
  url: "https://github.com/seaweedfs/seaweedfs/releases/download/4.48/linux_amd64.tar.gz",
});

export const celldBinary = (path: string): BinaryProps => ({
  asset: {
    format: "gz",
    memberSha256: "810b2a0b70e3420daee80f1d5378de5ba28651f0371ec7aa70b6c5de77e70d9e",
  },
  path,
  sha256: "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b",
  size: 25_122_717,
  url: "https://github.com/denoland/celld/releases/download/v0.6.1/celld-x86_64-unknown-linux-gnu.gz",
});
