import manifest from "../package.json";

export async function pluginUpdateMessage(request = fetch): Promise<string> {
  const latestUrl = "https://github.com/Jacox98/omp-agency-agents/releases/latest";
  const response = await request(latestUrl, {
    method: "HEAD", redirect: "manual",
    signal: AbortSignal.timeout(6000),
  });
  if (response.status !== 302) throw new Error(`GitHub returned HTTP ${response.status}`);
  const tag = response.headers.get("location")?.split("/releases/tag/")[1];
  if (typeof tag !== "string" || !/^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(tag)) throw new Error("Unrecognized release version");
  const installed = manifest.version.split(".").map(BigInt);
  const latest = tag.slice(1).split(".").map(BigInt);
  const difference = latest.findIndex((part, i) => part !== installed[i]);
  if (difference >= 0 && latest[difference] > installed[difference]) {
    return `Plugin update available: v${manifest.version} → ${tag}\nomp plugin install 'github:Jacox98/omp-agency-agents#${tag}'`;
  }
  return `No newer plugin release. Installed: v${manifest.version}. Latest: ${tag}.`;
}
