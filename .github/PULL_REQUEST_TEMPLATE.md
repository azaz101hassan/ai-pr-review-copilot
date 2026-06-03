## Summary

<!--
1–3 bullets covering what changed and why.
-->

-
-

## How this was verified

<!--
List what you ran. Examples:
  - npm test --workspace apps/api
  - npx tsc --noEmit
  - manual smoke: opened a real PR on the test repo, confirmed inline comments appeared
-->

## Pre-merge checklist

- [ ] Tests pass (`npm test --workspace apps/api`)
- [ ] Types clean (`npx tsc --noEmit` from `apps/api`)
- [ ] No new `process.env.X` reads outside `ConfigService`
- [ ] If a new table or column was added: migration generated and schema barrel updated
- [ ] If the seeded corpus changed: `npm run seed:knowledge --workspace apps/api` re-run and output checked

## Screenshots / output

<!-- Optional. Attach for UI changes or unexpected terminal output worth preserving. -->
