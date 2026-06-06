import { type FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { firebaseConfig } from "./config";

// Single Firebase app instance, shared by the auth/Firestore helpers and the
// YouTube backend callables (kept separate to avoid an import cycle).
export function firebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}
