# CanopyQuest

CanopyQuest is a camera-first, installable field game for mapping trees inside
the City of Orange, New Jersey. It reads the existing municipal tree inventory
and writes reviewable captures and findings to
[OrangeTreeDatabase](https://github.com/jameshward3/OrangeTreeDatabase), the
same production source used by OrangeTrees.

## Data contract

The browser uses the public production origin configured in
`database-config.js`. No private token or database credential is shipped to the
client.

- `GET /v1/trees` — current shared inventory (backward compatible)
- `GET /v1/findings` — current field findings (backward compatible)
- `POST /v1/players` — create or update a durable player by generated ID
- `GET /v1/players/:id/dashboard` — profile, quests, achievements, collections
- `POST /v1/captures` — idempotent capture, finding, rewards, and review state
- `GET /v1/leaderboards?period=weekly&metric=xp` — ranked durable results

AI output is explicitly labeled as an estimate. Captures store provider/model
version, confidence, corrections, dimension estimates, minimal image metadata,
GPS accuracy, heading, match confidence, and verification state. Public images
and historical movement trails are not stored.

## Local validation

```bash
npm test
npm run check
npm start
```

The service worker keeps the app shell and public map data available offline.
Unsynced capture metadata is verified in a bounded device queue; older
IndexedDB drafts migrate without deletion until the new queue confirms a
durable copy. Idempotency keys make retries safe, and the authoritative record
exists only after OrangeTreeDatabase confirms persistence.
