import { type FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import {
  type Firestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { firebaseConfig } from "./config";

/**
 * Single Firebase app instance, shared by the auth/Firestore helpers and the
 * YouTube backend callables (kept separate to avoid an import cycle).
 */
export function firebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

let firestore: Firestore | null = null;

/**
 * Firestore backed by its persistent (IndexedDB) cache rather than the default
 * in-memory one, so a listener paints before the server answers. Memoized because
 * `initializeFirestore` rejects a second call with different settings.
 */
export function firestoreDb(): Firestore {
  if (!firestore) {
    firestore = initializeFirestore(firebaseApp(), {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  }
  return firestore;
}
