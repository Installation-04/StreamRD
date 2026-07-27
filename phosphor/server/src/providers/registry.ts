import { AllDebridProvider } from "./alldebrid";
import { PremiumizeProvider } from "./premiumize";
import { RealDebridProvider } from "./realdebrid";
import { TorboxProvider } from "./torbox";
import { DebridProvider, ProviderId } from "./types";

/**
 * Registry of available provider implementations.
 * To add a new debrid service: implement DebridProvider, add its id to
 * PROVIDER_IDS in types.ts, and register an instance here.
 */
export const providers: Record<ProviderId, DebridProvider> = {
  realdebrid: new RealDebridProvider(),
  alldebrid: new AllDebridProvider(),
  premiumize: new PremiumizeProvider(),
  torbox: new TorboxProvider(),
};

export const getProvider = (id: ProviderId): DebridProvider => providers[id];
