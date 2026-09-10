/* Expedition Board — Firebase configuration.

   Set KS_FIREBASE_CONFIG to null to run the board as a local demo: sample data, this browser only.

   These values are not secrets. Anyone can read them from the page; access is controlled by
   firestore.rules and the allowlist collection, not by hiding the config.
   Source: Firebase console → Project settings → General → Your apps → Expedition Board → SDK setup. */

window.KS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAhInaL12gB35Bki0pVe6O6fhjVgd3f1CE",
  authDomain: "kresthalis-scheduling.firebaseapp.com",
  projectId: "kresthalis-scheduling",
  storageBucket: "kresthalis-scheduling.firebasestorage.app",
  messagingSenderId: "908299215215",
  appId: "1:908299215215:web:a6c56d4093c6fb73d8489a",
};
