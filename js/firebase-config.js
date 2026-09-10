/* Expedition Board — Firebase configuration.

   Leave KS_FIREBASE_CONFIG as null and the board runs as a local demo: sample data, this browser only.

   To go live, paste the firebaseConfig object from
     Firebase console → Project settings → General → Your apps → (your web app) → SDK setup and configuration
   and follow README.md → "Going live with Firebase".

   These values are not secrets. Anyone can read them from the page; access is controlled by
   firestore.rules and the allowlist collection, not by hiding the config. */

window.KS_FIREBASE_CONFIG = null;

// window.KS_FIREBASE_CONFIG = {
//   apiKey: "…",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   storageBucket: "your-project.firebasestorage.app",
//   messagingSenderId: "…",
//   appId: "…",
// };
