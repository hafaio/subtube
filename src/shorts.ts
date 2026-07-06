import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "./firebase-app";

// Shorts are capped at 3 minutes, so a longer video can't be one — the feed uses
// this to avoid probing videos that are provably not Shorts.
export const SHORTS_MAX_SECONDS = 180;

/**
 * Ask the backend to classify the given video ids as Shorts (it probes
 * youtube.com/shorts/{id} server-side, since the browser can't read that
 * cross-origin status, and caches verdicts globally). Returns id -> isShort;
 * unknown ids are simply absent.
 */
export async function classifyShorts(
  videoIds: string[],
): Promise<Map<string, boolean>> {
  if (videoIds.length === 0) {
    return new Map();
  }
  const call = httpsCallable<
    { videoIds: string[] },
    { shorts: Record<string, boolean> }
  >(getFunctions(firebaseApp()), "classifyShorts");
  const { data } = await call({ videoIds });
  // deserialize the wire object into a Map for in-memory use.
  return new Map(Object.entries(data.shorts));
}
