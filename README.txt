HADI REELS - complete package (Firebase project: hadi-app-a8c53)

FOLDER
  public/index.html     the whole app (one file)
  functions/            server part: gifts, free coins, withdrawals (needs Blaze plan)
  firestore.rules  storage.rules  database.rules.json   security rules
  firebase.json  .firebaserc   (hidden file, project link)

STEP 1 - in the Firebase console (console.firebase.google.com)
  1. Authentication > Sign-in method > turn on Email/Password AND Google
  2. Firestore Database > Create database (production mode)
  3. Storage > Get started
  4. Realtime Database > Create database (US). If its URL is not
     https://hadi-app-a8c53-default-rtdb.firebaseio.com , tell Claude the URL.
  5. Upgrade to the Blaze plan (card needed; free quota applies). Set a budget alert.

STEP 2 - on your computer (install Node.js 20 first)
  npm install -g firebase-tools
  firebase login
  cd functions
  npm install
  cd ..
  firebase deploy

STEP 3 - open the link firebase prints (Hosting URL, https://hadi-app-a8c53.web.app)
  The CEO is the Google account qr91388@gmail.com. Open the app, tap "Continue with Google",
  choose that Gmail and pick a username. That account becomes CEO (email must be verified by Google).
  If an older account was CEO before, set its role to 'admin' in Firestore > profiles.
  The hosting domain is already allowed for login.

MONEY
  Free daily coins were removed. Coins come only from buying (slip) or from the CEO.
  Withdrawals: you (CEO) approve each one. Check the account before you pay.
  Please read the warning about two accounts gifting each other to farm diamonds.

BUYING COINS (slip required)
  Users send money to Qasim Raza, JazzCash / Easypaisa 03244996576, then enter the
  Transaction ID and attach a photo of the payment slip. A request without a slip is
  refused by the server. The CEO opens Admin > Payments, taps "View slip", checks the
  money in the real JazzCash/Easypaisa app, then taps "Add coins". Only the CEO and the
  sender can ever see a slip.
  (The CEO can change the number later in Admin > Money settings.)

SIGN UP
  Every person has a separate account: email + username + password + birthday (13+),
  or "Continue with Google". Log in with username or email.

EMAIL
  New password accounts get a verification email automatically.
  Login screen has "Forgot password?": type the email in the first box, then tap it.
  (Old accounts made with only a username have no real email, so they cannot reset by email.)


PUSH NOTIFICATIONS (phone alerts)
  1. Firebase console > Project settings > Cloud Messaging > Web Push certificates > Generate key pair.
  2. Copy the key and paste it in public/index.html where it says window.PUSH_VAPID=window.PUSH_VAPID||'';  (between the last two quotes).
  3. firebase deploy   (this also deploys the push_event and push_msg functions and the new rules).
  4. In the app: Settings > Notifications > "Turn on phone notifications" (each user does this once).
  On iPhone the app must be added to the Home screen first.
