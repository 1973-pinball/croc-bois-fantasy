# Keeper cost review before manager onboarding

Reviewed October 1, 2026 against the public production records, frozen March 29 roster, workbook evidence, approved 2025 nominal-cost baseline and commissioner-marked 2025 draft. The sanitized per-player results and source hashes are in [keeper-readiness-audit.json](../data/keeper-readiness-audit.json).

The commissioner clarified on October 2 that the workbook's `2026 Draft` tab is the workspace for the upcoming draft. Blank player inputs are expected until selections are entered. Upcoming keeper costs are checked against the confirmed rules and frozen roster using the approved 2025 nominal-cost baseline and commissioner rulings.

## Result and limits

- All 111 current profiles agree numerically with the recomputation from the approved baseline, including eleven ineligible players. There is no newly discovered upcoming cost change to apply.
- All 111 player owners and all 104 pick identities, rounds and current owners match the reviewed bootstrap evidence. The three known transferred picks remain with their recorded owners.
- Production had 53 confirmed, 47 provisional and 11 ineligible profiles at the October 1 inspection. Migration 00008 confirmed eleven tenures from explicit draft/retention records. All costs, tenure values, roster ownership and pick records stayed unchanged.
- On October 3, the commissioner clarified that the first active undrafted season already counts as tenure one under the established rule, and authorized confirming every player with the same supported history. The 36 related profiles qualify; they do not require individual rule approvals. Six had already been confirmed manually when the new reconciliation snapshot was taken, leaving 30 provisional profiles to update.
- Numerical agreement does not independently certify every earlier keeper cycle, ownership transfer or source formula. Retained-player costs intentionally preserve the approved 2025 nominal baseline; remaining historical exceptions are described below.

## Eleven source-supported confirmations

Each player has a positive fresh-draft record in the completed 2024 board, is absent from the confirmed 2024 keeper list, and is marked as retained in the commissioner’s 2025 draft. Therefore 2024 is tenure one and 2025 is tenure two. Original blank fields and inferred-source metadata remain preserved.

| Player | 2026 base cost | Completed tenure |
| --- | ---: | ---: |
| Cade Cunningham | 2 | 2 |
| Jaylen Brown | 4 | 2 |
| OG Anunoby | 6 | 2 |
| Jalen Suggs | 7 | 2 |
| Zach Edey | 11 | 2 |
| Pascal Siakam | 4 | 2 |
| Austin Reaves | 10 | 2 |
| Jalen Green | 10 | 2 |
| Amen Thompson | 11 | 2 |
| Josh Giddey | 4 | 2 |
| Paolo Banchero | 5 | 2 |

Migration 00008 changes only verification and its explanation/evidence. It checks the exact original values and metadata before updating, records before/after audit events, and refuses an unexpected commissioner override atomically. It does not replay ownership, alter payment picks or rewrite the frozen roster. Reapplying the exact reviewed result is harmless. Fresh installations run the separate reconciliation SQL after the one-time seed.

## Established undrafted rule — October 3 resolution

Thirty players undrafted in 2025 carry base round 13 and tenure one. Six players undrafted in 2024 and kept in 2025 carry base round 12 and tenure two: Deni Avdija, Andrew Wiggins, Payton Pritchard, Dyson Daniels, Josh Hart and Quentin Grimes. The initial active undrafted season counts as year one; retaining the player for the next season adds one tenure year and advances the nominal cost. Applying this established rule resolves the unnecessary review flags.

Hart and Grimes had additional provisional cost labels pending a check of their 2024 history. Neither appears among the completed 2024 draft's 104 selections or the confirmed 2024 keeper list, and both are marked as kept in 2025. They therefore have the same supported history as the other retained undrafted players and fall within the commissioner's authorization. Hart paid a round-12 pick; Grimes paid a round-11 pick. Their nominal cost follows the undrafted base of 13 to round 12 for the 2026 keeper decision, independently of those payment picks.

Migration 00009 was applied to production on October 3. It confirmed the remaining 30 profiles with 30 before/after audit events, preserved all six existing commissioner confirmations and notes, and appended the rule evidence without changing any cost, tenure value, roster ownership or pick record. Production and the public API now report **100 confirmed, 11 ineligible and zero items to reconcile**. Original review flags remain as provenance.

## Historical exceptions retained

| Historical record | Disagreement | Current impact |
| --- | --- | --- |
| Giannis, 2025 | Historical target says ineligible while the corrected lifecycle produces round 1. | Preserved as a historical discrepancy; does not alter an eligible 2026 profile. |
| Dort, 2025 | Source contains conflicting targets of round 11 and round 12. | Preserved as conflicting source evidence; no current eligible roster correction results. |
| Lillard, 2024 | Source records round zero where the rules mean ineligible. | Zero remains historical evidence, not a legal keeper payment round. |

The original audit's 137 of 139 canonical 2025 matches remains unchanged. These older exceptions are separate from the upcoming roster’s readiness and must not be erased to make the replay appear perfect.
