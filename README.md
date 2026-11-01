# Genealogy server

The API stores the English and Bangla family trees, user profiles, and family change requests in MongoDB. Member additions and name corrections stay pending until an admin approves them. All profile and admin operations verify Firebase ID tokens on the server.

## Environment

Set these values in the local `.env` file and in the server deployment. Never commit credentials.

- `DB_USER` and `DB_PASS`: MongoDB credentials.
- `FIREBASE_PROJECT_ID`: `projectId` from the Firebase client configuration.
- `GENEALOGY_ADMIN_EMAIL`: first admin account. On startup, this account is made admin only if it has no `user_type` yet; later role changes are managed in the Admin dashboard.
- `IMGBB_API_KEY`: Imgbb API key used by the authenticated profile photo upload endpoint. Keep it server-side.
- `PORT`: optional; defaults to `2000`.

New authenticated users get `user_type: "user"`. Existing records without a role are migrated to `user`, except the configured first admin. The API requires outbound HTTPS access to Google's Firebase signing certificate endpoint and Imgbb's upload API.

## Run

```sh
npm install
npm run dev
```

## Render deployment

Use this folder as the Render web service root. Set the build command to `npm install` and the start command to `npm start`. Add `DB_USER`, `DB_PASS`, `FIREBASE_PROJECT_ID`, `GENEALOGY_ADMIN_EMAIL`, and `IMGBB_API_KEY` in the Render service environment, then restart or redeploy the service after changing them.
