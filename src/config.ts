/*
 * Public web config; safe to commit. Replace with your Firebase project's values
 * (Project settings -> General -> Your apps -> SDK setup and configuration).
 */
export const firebaseConfig = {
  apiKey: "AIzaSyDimHr1ESulbKwTg7VHyJyvHNgzvq8awhk",
  authDomain: "subtube-dev.firebaseapp.com",
  projectId: "subtube-dev",
  storageBucket: "subtube-dev.firebasestorage.app",
  messagingSenderId: "932619996481",
  appId: "1:932619996481:web:f4d3e16d87180756f365c0",
};

/*
 * OAuth 2.0 Web client ID from the same Google Cloud project (APIs & Services ->
 * Credentials -> "Web client (auto created by Google Service)"). Firebase Auth
 * signs in with it for identity only (no YouTube scope); YouTube access uses a
 * separate Authorization Code popup whose code is exchanged server-side, and
 * silent re-mint goes through the refreshYouTubeToken callable (Google removed
 * client-side silent minting). Register both your dev (http://localhost:3000)
 * and Pages URLs as "Authorized JavaScript origins" AND as "Authorized redirect
 * URIs" on this client — the connect popup needs both.
 */
export const oauthClientId =
  "932619996481-qtf3mtbe40o315ptk6rm7ieuvn61akkm.apps.googleusercontent.com";
